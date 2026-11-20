/**
 * Plan/Act model router — Host half.
 *
 * The plugin makes the Plan/Act choice a *selection*, not a request rewrite. The
 * dropdown in the composer and these two automatic rules all go through
 * `session.selectModel`, so the Harness keeps a single notion of "which model
 * answers next" and the native selector, the durable log and the chip agree.
 *
 * Two rules survive, and only two:
 *
 * - entering plan mode selects the configured Plan route (soft: the user may
 *   immediately pick something else);
 * - approving `exit_plan_mode` selects the configured Act route, ignoring
 *   whatever was selected while planning (hard).
 *
 * `/plan off` is deliberately not a trigger: leaving plan mode by any route
 * other than an approval leaves the selection alone.
 *
 * Every decision lives in `lib/routing.mjs`, which has no Host dependency and is
 * unit-tested directly; the Host plumbing lives in `lib/host.mjs`.
 */
import { loadSchema } from './lib/schema.mjs'
import { committedSelection, createCatalog, createSwitcher } from './lib/host.mjs'
import {
  PROMPT_ORDER,
  PROMPT_SECTION,
  modeInstruction,
  resolveMode,
  routeConflicts,
} from './lib/mode-prompt.mjs'
import {
  MODE_ACT,
  MODE_PLAN,
  projectKey,
  switchActOnApproval,
  switchPlan,
  unref,
} from './lib/routing.mjs'

/** The profile supplies schemastery; a linked bundle cannot import it directly. */
const z = await loadSchema()

/**
 * `agents` is required; everything else is read lazily through `ctx.get` so the
 * plugin still loads in a profile that disables those services.
 */
export const inject = ['agents']

const Route = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

/**
 * One user-defined mode: a display name plus the same route a track carries.
 *
 * The table is keyed by an id the client generates (`m1`, `m2`, …). The name is
 * presentation only — the session stores the provider/model/effort it was
 * switched to, never the mode id — so renaming a mode never disturbs a session.
 */
const CustomMode = z.object({
  name: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

const ProjectEntry = z.object({
  mode: z.union(['inherit', 'override', 'off']).default('inherit'),
  plan: Route.default({}),
  act: Route.default({}),
})

/**
 * Per-track system instructions, keyed by track id (`plan`, `act`, or a custom
 * mode id) — the same keys `modes` uses. An instruction is contributed to the
 * system prompt while its track is the one the session sits on, so switching
 * modes also switches the role the model is asked to play.
 */
const Prompts = z.dict(z.string()).default({})

/** Volatile fields are the only ones a settings page may read or write. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  plan: Route.volatile(),
  act: Route.volatile(),
  modes: z.dict(CustomMode).default({}).volatile(),
  projects: z.dict(ProjectEntry).default({}).volatile(),
  prompts: Prompts.volatile(),
})

/** Catalog lookups are cheap but not free; one shared snapshot is enough. */
const CATALOG_TTL_MS = 15_000

/**
 * Read the live configuration out of its volatile cells.
 * @param config - the validated Config the Loader handed to `apply`.
 */
function readConfig(config) {
  return {
    enabled: unref(config?.enabled) === true,
    plan: unref(config?.plan),
    act: unref(config?.act),
    // Read only so `sessionTrack` can tell whether a committed selection sits on
    // a custom mode. No automatic rule ever switches *to* one.
    modes: unref(config?.modes),
    projects: unref(config?.projects),
    prompts: unref(config?.prompts) ?? {},
  }
}

/** Accept both an Agent and an `{ agent }` payload or handle. */
function agentOf(raw) {
  const candidate = raw?.agent ?? raw
  return candidate?.ctx === undefined ? undefined : candidate
}

/** The Agent's identity, whichever field this Harness generation exposes. */
function idOf(agent) {
  return agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id
}

/** The workspace root, normalized the same way the project-override keys are. */
function rootOf(agent) {
  return projectKey(agent?.session?.header?.cwd ?? '')
}

/**
 * Mount the router.
 * @param ctx - Host plugin context.
 * @param config - validated Config.
 */
export function apply(ctx, config) {
  const attached = new WeakSet()
  /** Strong set so `ctx.effect` teardown can dispose the listeners it mounted. */
  const live = new Set()
  /**
   * The track each session last committed a switch *to*.
   *
   * The session log records provider/model/effort, never the mode id, so two
   * tracks sharing one route are indistinguishable from the selection alone.
   * Remembering our own switches is what keeps the instruction attached to the
   * mode the user actually chose. A manual pick from the dropdown does not pass
   * through here; it needs no memory unless the routes collide.
   */
  const remembered = new WeakMap()

  /**
   * Sessions with a plan-mode switch that has been decided but not yet applied.
   *
   * Entering plan mode is announced from inside the `plan/mode` append, where
   * the selection cannot be committed yet: the session is mid-publish, and
   * committing appends a second event into the same window. So the intent is
   * armed here and flushed as soon as the stack unwinds — or, when `/plan` also
   * steers a message, as soon as the Agent leaves idle for that step, which is
   * still earlier than `preStep` reading the model.
   */
  const armed = new WeakMap()

  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const projections = () => ctx.get('sessionProjections')
  const { servableNow, refresh } = createCatalog({ llm: () => ctx.get('llm'), ttlMs: CATALOG_TTL_MS })
  const select = createSwitcher({
    sessionController: () => ctx.get('sessionController'),
    projections,
    servableNow,
    warm: refresh,
    warn: (message) => ctx.logger?.warn?.(message),
  })

  /**
   * Run a switch without letting a rejection escape into the Host's event loop.
   * The switcher already reports its own failures; this only stops an unexpected
   * bug from surfacing as an unhandled rejection in the session log.
   */
  function schedule(promise) {
    void Promise.resolve(promise).catch(() => {})
  }

  /**
   * Report a configuration that silently disables an automatic rule.
   *
   * A route with no provider/model cannot be selected, and staying quiet would
   * leave the user with a plan-mode switch that simply does nothing. Once per
   * track is enough; the settings page is where it gets fixed.
   */
  const incompleteReported = new Set()
  function reportIncomplete(track, verdict) {
    if (verdict.action !== 'pass' || verdict.reason !== 'route-incomplete') return
    if (incompleteReported.has(track)) return
    incompleteReported.add(track)
    const label = track === MODE_PLAN ? 'Plan' : 'Act'
    ctx.logger?.warn?.(
      `[plan-act-models] ${label} 路由缺少 provider 或 model，自动切换已跳过；`
      + '请在“设置 → 双轨 · Plan / Act 模型”里补全。',
    )
  }

  /**
   * Which track this session is on, and the instruction that follows from it.
   *
   * The plan flag only breaks a tie between tracks that share a route; the
   * remembered track wins first, because it records a choice the log cannot.
   */
  function trackOf(agent) {
    const session = agent?.session
    if (session === undefined) return null
    if (session.header?.origin === 'subagent') return null
    const cfg = readConfig(config)
    return resolveMode({
      config: cfg,
      path: rootOf(agent),
      selection: committedSelection(projections, session),
      planActive: planActiveOf(agent),
      remembered: remembered.get(session),
    })
  }

  /**
   * Whether plan mode is on, whichever of the two signals this Host exposes.
   *
   * Returns `undefined` when nothing on this Host can answer, which is not the
   * same as "off": the listener that armed the switch already saw the signal.
   */
  function planValueOf(agent) {
    try {
      const planMode = ctx.get('planMode')
      const verdict = planMode?.get?.(agent)
      // A queued flip (entry requested while a turn is open) is not committed
      // until the next step boundary, but it is the user's current intent, and
      // the instruction should not lag behind the switch by one step.
      if (verdict !== undefined) return (verdict?.pending ?? verdict?.active) === true
    } catch {
      // Fall through to the projection: a Host without `planMode` still logs.
    }
    try {
      const state = projections()?.stateOf?.(agent?.session, 'plan')
      if (state === undefined || state === null) return undefined
      return state?.active === true
    } catch {
      return undefined
    }
  }

  /** Whether plan mode is on, treating "cannot tell" as off for display. */
  function planActiveOf(agent) {
    return planValueOf(agent) === true
  }

  /**
   * Contribute the active mode's instruction to the system prompt.
   *
   * Registered lazily, through `ctx.inject`, so a profile without the prompt
   * registry still loads the router. The section renders `''` (and is dropped
   * from the prompt entirely) whenever the session adds no instruction, which
   * is the common case.
   */
  ctx.inject(['systemPrompt'], (child) => {
    child.effect(() =>
      child.systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: (context) => {
          const agent = context?.agent
          if (agent === undefined) return ''
          const track = trackOf(agent)
          if (track === null) return ''
          const { text, truncated } = modeInstruction({ config: readConfig(config), track })
          if (text === '') return ''
          // A truncated instruction would otherwise end mid-sentence with no sign
          // of it, and the user would blame the model for the missing half.
          return truncated ? `${text}\n\n(Instruction truncated by plan-act-models.)` : text
        },
      }),
    )
  })

  // Two tracks resolving to one route cannot be told apart from the log, so the
  // user is entitled to know before wondering why one mode's instruction never
  // appears. Reported once per activation; the settings page shows it too.
  try {
    const cfg = readConfig(config)
    for (const group of routeConflicts(cfg, '')) {
      const names = group
        .map((track) => (track === MODE_PLAN || track === MODE_ACT ? track : `模式 ${track}`))
        .join('、')
      ctx.logger?.warn?.(
        `[plan-act-models] ${names} 的路由完全相同，切换时无法区分；`
        + '请为它们选择不同的 model 或 reasoningEffort，否则只会套用其中一个模式的提示词。',
      )
    }
  } catch {
    // A malformed configuration must not stop the plugin from loading.
  }

  /**
   * The hard rule: an approved plan always carries out on the Act route.
   *
   * Only `exit_plan_mode` returning `approved: true` counts. Falling back to the
   * absence of plan mode would fire on `/plan off` too, and the user asked for
   * exactly the opposite there.
   */
  function onToolResult(agent) {
    return (exec, result) => {
      if (exec?.name !== 'exit_plan_mode') return
      if (result?.isError === true) return
      if (result?.value?.approved !== true) return
      const cfg = readConfig(config)
      const verdict = switchActOnApproval({
        enabled: cfg.enabled,
        config: cfg,
        path: rootOf(agent),
        current: committedSelection(projections, agent?.session),
      })
      reportIncomplete(MODE_ACT, verdict)
      if (verdict.action !== 'select') return
      // The approved plan supersedes any plan entry that is still queued, so a
      // later flush cannot drag the session back onto the Plan route.
      armed.delete(agent)
      // Remember before the switch lands: prompt assembly for the next step may
      // run before the selection projection settles.
      remembered.set(agent.session, MODE_ACT)
      schedule(select(agent, verdict.route, idOf(agent)))
    }
  }

  /**
   * The soft rule: entering plan mode selects the Plan route.
   *
   * `plan/mode` is the only committed signal every entry and exit path emits, so
   * one listener here covers `/plan`, the Plan chip and any future control
   * without the plugin touching plan mode itself.
   */
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'plan/mode') return
    if (event?.data?.active !== true) return
    let agent
    try {
      agent = ctx.agents.get(session.id)
    } catch {
      agent = undefined
    }
    if (agent === undefined) return
    const cfg = readConfig(config)
    const verdict = switchPlan({
      enabled: cfg.enabled,
      config: cfg,
      path: projectKey(session.header?.cwd ?? ''),
      current: committedSelection(projections, session),
      mode: MODE_PLAN,
    })
    reportIncomplete(MODE_PLAN, verdict)
    if (verdict.action !== 'select') return
    remembered.set(session, MODE_PLAN)
    // `plan/mode` is appended from inside the session's own publish, and the
    // switch appends `model/selection`; doing it here would re-enter the append.
    armed.set(agent, { session, route: verdict.route })
    queueMicrotask(() => flushPlan(agent))
  })

  /**
   * Apply an armed plan-mode switch, if it is still wanted.
   *
   * Flushed from a microtask (enough for `/plan` and the chip: the user's next
   * message starts the turn) and again from `agent/status` (needed for
   * `/plan <message>`, which wakes the Agent inside the same stack). Whichever
   * runs first wins; the intent is dropped either way.
   */
  function flushPlan(agent) {
    const intent = armed.get(agent)
    if (intent === undefined) return
    armed.delete(agent)
    // The arming listener saw `plan/mode active:true`; a Host that cannot
    // report it back yet (`planMode.get()` returning nothing) must not cancel a
    // decision it already announced. Only an explicit "off" cancels.
    if (planValueOf(agent) === false) return
    // The switcher drops a route the session already committed to.
    schedule(select(agent, intent.route, intent.session.id))
  }

  /**
   * Report a bug inside the plugin instead of letting it escape.
   *
   * `attach` runs synchronously inside the Host's `agent/created` serial, and
   * that serial does not catch: one throw there stops the Agent from ever being
   * published and leaves the session unusable. So attachment and detachment
   * swallow their own failures and say so once, and the Agent keeps working
   * without automatic switching.
   */
  let reported = false
  function report(error) {
    if (reported) return
    reported = true
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[plan-act-models] 无法为该会话挂载切换器，已跳过（其余会话不受影响）：${detail}`)
  }

  /** Attach the Agent-scoped listeners, once. */
  function attach(raw) {
    const agent = agentOf(raw)
    if (agent === undefined || attached.has(agent)) return
    if (agent.session?.header?.origin === 'subagent') return
    attached.add(agent)
    try {
      agent.disposeToolResult = agent.ctx.on('tools/result', onToolResult(agent))
      // `agent/status` is the moment an Agent leaves idle, which is the last
      // chance to commit a selection before `preStep` reads it. Older Hosts do
      // not emit it for a step that was woken in the same stack; the microtask
      // in the plan listener already covers those.
      if (typeof agent.model?.select === 'function') {
        agent.disposeStatus = agent.ctx.on('agent/status', (payload) => {
          if (payload?.status === 'running') flushPlan(agent)
        })
      }
      live.add(agent)
    } catch (error) {
      attached.delete(agent)
      report(error)
    }
  }

  function drop(raw) {
    try {
      const agent = agentOf(raw)
      if (agent === undefined) return
      attached.delete(agent)
      live.delete(agent)
      armed.delete(agent)
      agent.disposeToolResult?.()
      agent.disposeToolResult = undefined
      agent.disposeStatus?.()
      agent.disposeStatus = undefined
    } catch (error) {
      report(error)
    }
  }

  ctx.on('agent/created', (payload) => attach(payload))
  ctx.on('agent/disposed', (payload) => drop(payload))

  // A Loader reload or a settings write that re-activates the plugin starts a
  // new `apply` while Agent listeners may already be gone; adopt the Agents
  // that already exist so switching continues where it left off.
  try {
    for (const agent of ctx.agents.roots?.() ?? []) attach(agent)
  } catch (error) {
    report(error)
  }

  ctx.effect(() => () => {
    for (const agent of [...live]) drop(agent)
  })
}
