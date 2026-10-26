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

const ProjectEntry = z.object({
  mode: z.union(['inherit', 'override', 'off']).default('inherit'),
  plan: Route.default({}),
  act: Route.default({}),
})

/** Volatile fields are the only ones a settings page may read or write. */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  plan: Route.volatile(),
  act: Route.volatile(),
  projects: z.dict(ProjectEntry).default({}).volatile(),
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
    projects: unref(config?.projects),
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

  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const projections = () => ctx.get('sessionProjections')
  const { assertServable } = createCatalog({ llm: () => ctx.get('llm'), ttlMs: CATALOG_TTL_MS })
  const select = createSwitcher({
    sessionController: () => ctx.get('sessionController'),
    projections,
    assertServable,
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
    schedule(select(agent, verdict.route, session.id))
  })

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

  /** Attach the Agent-scoped listener, once. */
  function attach(raw) {
    const agent = agentOf(raw)
    if (agent === undefined || attached.has(agent)) return
    if (agent.session?.header?.origin === 'subagent') return
    attached.add(agent)
    try {
      agent.disposeToolResult = agent.ctx.on('tools/result', onToolResult(agent))
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
      agent.disposeToolResult?.()
      agent.disposeToolResult = undefined
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
