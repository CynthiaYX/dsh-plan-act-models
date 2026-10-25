/**
 * Plan/Act model router — Host half.
 *
 * The plugin never edits the Harness and never rewrites the profile default: it
 * attaches one Agent-scoped listener set to every runtime-root Agent and
 * rewrites the resolved request route when the committed plan state names the
 * other mode. Every decision lives in `lib/routing.mjs`, which has no Host
 * dependency and is unit-tested directly.
 */
import { loadSchema } from './lib/schema.mjs'
import { createCatalog, createModeReader } from './lib/host.mjs'
import {
  createState,
  decide,
  previewRoute,
  projectKey,
  resolveTarget,
  unref,
  withRoute,
} from './lib/routing.mjs'

/** The profile supplies schemastery; a linked bundle cannot import it directly. */
const z = await loadSchema()

/**
 * `agents` is required; plan mode is optional so the plugin stays alive without
 * it. `agentPresets` and `sessionProjections` are read lazily through `ctx.get`
 * for the same reason: requiring them here would stop the plugin from loading at
 * all in a profile that disables those services.
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

/** A resumed session already has a request header written by an earlier run. */
function resumed(agent) {
  return agent?.session?.requestHeader?.() !== undefined
}

/**
 * Mount the router.
 * @param ctx - Host plugin context.
 * @param config - validated Config.
 */
export function apply(ctx, config) {
  const states = new Map()
  const attached = new WeakSet()

  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const modeOf = createModeReader({
    agentPresets: () => ctx.get('agentPresets'),
    projections: () => ctx.get('sessionProjections'),
    warn: (message) => ctx.logger?.warn?.(message),
  })

  const { assertServable } = createCatalog({ llm: () => ctx.get('llm'), ttlMs: CATALOG_TTL_MS })

  /**
   * Whether a resolved request config already equals the wanted route.
   * @param resolved - what the inner listeners resolved.
   * @param route - the route this plugin wants.
   */
  function alreadyRouted(resolved, route) {
    return (
      resolved?.provider === route.provider
      && resolved?.model === route.model
      && (resolved?.reasoningEffort ?? '') === (route.reasoningEffort ?? '')
    )
  }

  /**
   * Rewrite one resolved request route.
   * A throw here ends the turn with a visible failure row — the fail-closed
   * path. Deliberately not `agent/pre-step` rejection: a persistent reject
   * leaves Plan mode's committed transition pending and can wedge the switch.
   */
  function requestListener(agent, state) {
    return async (_payload, next) => {
      const resolved = await next()
      const cfg = readConfig(config)
      const mode = modeOf(agent)
      const target = resolveTarget(cfg, rootOf(agent), mode)
      const verdict = decide(state, { enabled: cfg.enabled, mode, resolved, target })
      if (verdict.action === 'block') throw new Error(verdict.message)
      if (verdict.action !== 'route') return resolved
      if (alreadyRouted(resolved, verdict.route)) return resolved
      await assertServable(verdict.route)
      return withRoute(resolved, verdict.route)
    }
  }

  /** Keep the assembly variables in step with the route the next request uses. */
  function assembleListener(agent, state) {
    return async (assembly, _context, next) => {
      const assembled = await next()
      const cfg = readConfig(config)
      const target = resolveTarget(cfg, rootOf(agent), modeOf(agent))
      const route = cfg.enabled ? previewRoute(state, target) : null
      if (route === null) return assembled
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: route.provider, model: route.model },
      }
    }
  }

  /**
   * Drop the Harness's own "[model changed: …]" notice when this plugin is the
   * one routing. That notice describes the session's own selection, which the
   * plugin overrides, so keeping it would state the opposite of the truth — and
   * it would repeat on every step while the two selections differ.
   */
  function preStepListener(agent, state) {
    return async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const cfg = readConfig(config)
      if (!cfg.enabled) return decision
      const target = resolveTarget(cfg, rootOf(agent), modeOf(agent))
      if (previewRoute(state, target) === null) return decision
      const kept = decision.messages.filter(
        (message) => message?.source?.kind !== 'model-selection',
      )
      if (kept.length === decision.messages.length) return decision
      if (kept.length === 0) {
        // Never hand the step an empty batch when the notice was the only input.
        return decision.kind === 'enter' ? { ...decision, messages: decision.messages.slice(-1) } : decision
      }
      return { ...decision, messages: kept }
    }
  }

  /**
   * Report a bug inside the plugin instead of letting it escape.
   *
   * `attach` runs synchronously inside the Host's `agent/created` serial, and
   * that serial does not catch: one throw there stops the Agent from ever being
   * published and leaves the session unusable (no composer, no replies) — a far
   * worse outcome than simply not re-routing that Agent. So attachment and
   * detachment swallow their own failures and say so once.
   *
   * Request-time failures are deliberately NOT caught here: a `block` verdict
   * must surface as a visible error row, which is the documented fail-closed
   * behaviour.
   */
  let reported = false
  function report(error) {
    if (reported) return
    reported = true
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[plan-act-models] 无法为该会话挂载路由，已跳过（其余会话不受影响）：${detail}`)
  }

  /** Attach one Agent-scoped listener set, once. */
  function attach(raw) {
    const agent = agentOf(raw)
    if (agent === undefined || attached.has(agent)) return
    if (agent.session?.header?.origin === 'subagent') return
    attached.add(agent)
    try {
      const state = createState({ mode: modeOf(agent), resumed: resumed(agent) })
      const id = idOf(agent)
      if (id !== undefined) states.set(id, { state, agent })
      const disposeRequest = agent.ctx.on('agent/request', requestListener(agent, state), {
        prepend: true,
      })
      const disposeAssemble = agent.ctx.on('system-prompt/assemble', assembleListener(agent, state), {
        prepend: true,
      })
      const disposePreStep = agent.ctx.on('agent/pre-step', preStepListener(agent, state), {
        prepend: true,
      })
      state.detach = () => {
        disposeRequest()
        disposeAssemble()
        disposePreStep()
        attached.delete(agent)
        if (id !== undefined) states.delete(id)
      }
    } catch (error) {
      attached.delete(agent)
      report(error)
    }
  }

  function drop(raw) {
    try {
      const agent = agentOf(raw)
      const id = idOf(agent ?? raw)
      const entry = id === undefined ? undefined : states.get(id)
      entry?.state.detach?.()
    } catch (error) {
      report(error)
    }
  }

  ctx.on('agent/created', (payload) => attach(payload))
  ctx.on('agent/disposed', (payload) => drop(payload))

  // A Loader reload or a settings write that re-activates the plugin starts a
  // new `apply` while Agent listeners may already be gone; adopt the Agents
  // that already exist so routing continues where it left off.
  try {
    for (const agent of ctx.agents.roots?.() ?? []) attach(agent)
  } catch (error) {
    report(error)
  }

  ctx.effect(() => () => {
    for (const { state } of [...states.values()]) {
      try {
        state.detach?.()
      } catch (error) {
        report(error)
      }
    }
    states.clear()
  })
}

