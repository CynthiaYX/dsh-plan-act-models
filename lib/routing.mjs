/**
 * Pure routing policy for the Plan/Act model router.
 *
 * Nothing here imports the Host: every function takes plain values and returns
 * plain values, so `test/routing.test.mjs` exercises the whole decision table
 * without a running Harness.
 */

/** Mode identifiers used by the Host plan projection. */
export const MODE_PLAN = 'plan'
export const MODE_ACT = 'act'

/**
 * Unwrap the reactive cell a volatile Config field arrives as.
 * Loader configs hand business plugins a cell per volatile field (`cell.get()`),
 * while plain objects and already-resolved values pass through unchanged.
 */
export function unref(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object' && typeof value !== 'function') return value
  if (typeof value.get === 'function') {
    try {
      return unref(value.get())
    } catch {
      return undefined
    }
  }
  if (typeof value === 'function') return unref(value())
  if (Object.prototype.hasOwnProperty.call(value, 'value') && typeof value.get !== 'function') {
    return unref(value.value)
  }
  return value
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Normalize a stored route into `{ provider, model, reasoningEffort? }`.
 * @returns the route, or null when provider or model is missing.
 */
export function normalizeRoute(input) {
  const value = unref(input)
  if (value === null || typeof value !== 'object') return null
  const provider = text(value.provider)
  const model = text(value.model)
  if (provider === '' || model === '') return null
  const effort = text(value.reasoningEffort)
  return effort === '' ? { provider, model } : { provider, model, reasoningEffort: effort }
}

/** Same provider+model; effort is irrelevant for "which model answered". */
export function sameRoute(left, right) {
  return left !== null && right !== null && left.provider === right.provider && left.model === right.model
}

/** Same provider+model+effort, used to detect a changed Host selection. */
export function sameSelection(left, right) {
  if (!sameRoute(left, right)) return false
  return (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/** Human-readable route, e.g. `deepseek-account/deepseek-flash (max)`. */
export function formatRoute(route) {
  if (route === null || route === undefined) return 'none'
  const effort = route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`
  return `${route.provider}/${route.model}${effort}`
}

/** Stable comparison key for a project path. */
export function projectKey(path) {
  const raw = text(path)
  if (raw === '') return ''
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Find the project override whose key matches `path`, if any. */
export function findProject(projects, path) {
  const table = unref(projects)
  const want = projectKey(path)
  if (want === '' || table === null || typeof table !== 'object') return null
  for (const key of Object.keys(table)) {
    if (projectKey(key) === want) return { key, entry: unref(table[key]) }
  }
  return null
}

/** Read the `mode` of one project entry (`inherit` | `override` | `off`). */
export function projectMode(entry) {
  const value = unref(entry)
  if (value === null || typeof value !== 'object') return 'inherit'
  const mode = text(value.mode)
  return mode === 'override' || mode === 'off' ? mode : 'inherit'
}

/**
 * Resolve which route a session should use.
 *
 * @returns {{kind:'route',route:object,scope:string,projectKey:?string}
 *          |{kind:'off',scope:string,projectKey:?string}
 *          |{kind:'invalid',scope:string,projectKey:?string,reason:string}}
 */
export function resolveTarget(config, path, mode) {
  const hit = findProject(config?.projects, path)
  const entryMode = hit === null ? 'inherit' : projectMode(hit.entry)
  const scope = hit === null || entryMode === 'inherit' ? 'global' : 'project'
  const key = hit === null ? null : hit.key

  if (entryMode === 'off') return { kind: 'off', scope: 'project', projectKey: key }

  const source = entryMode === 'override' ? unref(hit.entry)[mode] : unref(config?.[mode])
  const route = normalizeRoute(source)
  if (route === null) {
    return {
      kind: 'invalid',
      scope,
      projectKey: key,
      reason: entryMode === 'override'
        ? `项目覆盖「${key}」的 ${mode} 路由缺少 provider 或 model`
        : `全局 ${mode} 路由缺少 provider 或 model`,
    }
  }
  return { kind: 'route', route, scope, projectKey: key }
}

/** Fresh state for one Agent. */
export function createState({ mode, resumed }) {
  return {
    observedMode: mode,
    /** Last route the inner listeners resolved for this Agent, before our rewrite. */
    hostSeen: null,
    bypass: resumed === true,
    lastApplied: null,
    /** Whether the previous decision ran while the plugin was switched off. */
    wasDisabled: false,
  }
}

/**
 * Decide one request.
 *
 * `bypass` is the temporary manual override: it starts as true for a resumed
 * session (the plugin must not switch a session that already existed) and is
 * set whenever the Host's own selection changes, which is how a manual pick in
 * the native selector surfaces. A committed Plan↔Act change clears it.
 *
 * Being switched off is *not* a manual override: it is tracked separately so
 * that switching the plugin back on resumes routing in the same mode instead of
 * leaving the session stuck in pass-through until the next Plan↔Act change.
 *
 * @param state - mutable per-agent state from {@link createState}
 * @param input.enabled - whether the plugin is on
 * @param input.mode - committed mode, `plan` | `act`
 * @param input.resolved - the Host selection this request would otherwise use
 * @param input.target - result of {@link resolveTarget}
 * @returns {{action:'pass',reason:string}|{action:'route',route:object,scope:string}|{action:'block',message:string}}
 */
export function decide(state, input) {
  const { enabled, mode, resolved, target } = input

  if (state.observedMode !== mode) {
    state.observedMode = mode
    state.bypass = false
  }

  if (enabled !== true) {
    // Forget the baseline: whatever the Host settles on while the plugin is off
    // is not a manual pick, and re-baselining avoids a false override on the
    // first request after re-enabling.
    state.wasDisabled = true
    state.hostSeen = null
    return { action: 'pass', reason: 'disabled' }
  }

  if (state.wasDisabled) {
    state.wasDisabled = false
    state.bypass = false
    state.hostSeen = null
  }

  const current = normalizeRoute(resolved)

  // Detect a manual pick by watching the route the *inner* listeners resolve.
  // Two values are not manual picks: the value we already forced (the loop logs
  // it as the request header, and the session selection falls back to that
  // header on the next step, so it echoes back at us), and any repeat of it.
  //
  // The comparison includes `reasoningEffort`: a Plan and an Act route may share
  // provider+model and differ only in effort, so comparing provider+model alone
  // would silently ignore an effort-only pick in the native selector.
  if (current !== null) {
    if (state.hostSeen === null) state.hostSeen = current
    else if (!sameSelection(state.hostSeen, current)) {
      state.hostSeen = current
      if (!sameSelection(state.lastApplied, current)) state.bypass = true
    }
  }

  if (target.kind === 'off') return { action: 'pass', reason: 'project-disabled' }
  if (state.bypass) return { action: 'pass', reason: 'override' }

  if (target.kind === 'invalid') {
    return { action: 'block', message: target.reason }
  }

  state.lastApplied = target.route
  return { action: 'route', route: target.route, scope: target.scope }
}

/** The route the next request will actually use, when the plugin forces one. */
export function previewRoute(state, target) {
  if (state.bypass || target.kind !== 'route') return null
  return target.route
}

/** Merge a forced route into a resolved request config. */
export function withRoute(resolved, route) {
  const { reasoningEffort: _inherited, ...rest } = resolved ?? {}
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}
