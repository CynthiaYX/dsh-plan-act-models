/**
 * Pure routing policy for the Plan/Act model router.
 *
 * Nothing here imports the Host: every function takes plain values and returns
 * plain values, so `test/routing.test.mjs` exercises the whole decision table
 * without a running Harness.
 *
 * The policy no longer rewrites requests. A mode is a *track* (`plan`, `act`, or
 * the id of a user-defined mode), the committed selection belongs to the Host's
 * own `model/selection` projection, and this module only answers two questions:
 *
 * 1. Which track does a selection correspond to (`sessionTrack`)?
 * 2. Should an event switch the selection to the other track (`switchPlan`,
 *    `switchActOnApproval`)?
 *
 * Custom modes only add candidates to the first question. They carry no rule of
 * their own: nothing switches *to* them, so the two rules above keep their
 * meaning and override whatever custom mode the user had picked.
 */

/** Track identifiers with a config field of their own and an automatic rule. */
export const MODE_PLAN = 'plan'
export const MODE_ACT = 'act'

/** The fixed tracks, in the order the dropdown offers them. */
export const BUILTIN_TRACKS = [MODE_PLAN, MODE_ACT]

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

/** Same provider+model+effort, used to detect an unchanged committed selection. */
export function sameSelection(left, right) {
  if (!sameRoute(left, right)) return false
  return (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/**
 * Whether a committed selection is the same track as a configured route.
 *
 * A configuration that leaves `reasoningEffort` empty means "follow the model
 * default", and the Host writes the resolved default back into the committed
 * selection. Comparing the effort there would make every such route look
 * different from itself, so an empty configured effort matches any effort.
 */
export function sameTrack(selection, wanted) {
  const current = normalizeRoute(selection)
  const target = normalizeRoute(wanted)
  if (current === null || target === null) return false
  if (!sameRoute(current, target)) return false
  if (target.reasoningEffort === undefined) return true
  return current.reasoningEffort === target.reasoningEffort
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

/** The custom-mode table as a plain object, whatever shape the cell arrived in. */
export function modesOf(config) {
  const table = unref(config?.modes)
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return {}
  return table
}

/**
 * The name a custom mode is displayed under.
 *
 * An empty name is not a reason to drop the entry — the route is still usable —
 * so it falls back to a positional default. The ordinal is 1-based and follows
 * the stored order, which is what makes the fallback stable across reloads: the
 * client renders the same word without sharing state with the Host.
 *
 * @param entry - the stored `{ name, provider, model, reasoningEffort }`.
 * @param index - 0-based position in the stored table.
 */
export function customName(entry, index) {
  const value = unref(entry)
  const name = value !== null && typeof value === 'object' ? text(value.name) : ''
  return name === '' ? `模式 ${index + 1}` : name
}

/**
 * The user-defined modes, in the order they were added.
 *
 * @param config - the plugin configuration.
 * @returns `[{ id, name, complete }]`; `complete` is false when the entry cannot
 *   be selected yet, so the caller can show it without offering it.
 */
export function customTracks(config) {
  const table = modesOf(config)
  return Object.keys(table).map((id, index) => {
    const entry = unref(table[id])
    return {
      id,
      name: customName(entry, index),
      complete: normalizeRoute(entry) !== null,
    }
  })
}

/**
 * Resolve which route one track means for a session.
 *
 * `plan` and `act` read the global pair and honour a project override. A custom
 * mode has no project row of its own — that table stays a pair, so an `override`
 * entry cannot name a custom route — and always resolves from the global table.
 *
 * A project set to `off` still wins for every track: "disabled in this project"
 * is a property of the project, not of the track being asked about.
 *
 * @param config - the plugin configuration (`enabled`/`plan`/`act`/`modes`/`projects`).
 * @param path - the session's workspace root.
 * @param mode - `plan` | `act` | the id of a custom mode
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

  const builtin = mode === MODE_PLAN || mode === MODE_ACT
  const source = builtin
    ? (entryMode === 'override' ? unref(hit.entry)[mode] : unref(config?.[mode]))
    : unref(modesOf(config)[mode])

  if (!builtin) {
    // A project override says nothing about a custom mode; the row is global, so
    // the report must not claim the project narrowed it.
    const route = normalizeRoute(source)
    if (route === null) {
      const index = Object.keys(modesOf(config)).indexOf(mode)
      const name = index < 0 ? mode : customName(source, index)
      return {
        kind: 'invalid',
        scope: 'global',
        projectKey: null,
        reason: `自定义模式「${name}」缺少 provider 或 model`,
      }
    }
    return { kind: 'route', route, scope: 'global', projectKey: null }
  }

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

/**
 * Every track a selection could name, in dropdown order.
 *
 * @param config - the plugin configuration.
 * @returns `[{ id, name, builtin }]` — plan, act, then the custom modes.
 */
export function tracksOf(config) {
  const modes = modesOf(config)
  const custom = Object.keys(modes).map((id, index) => ({
    id,
    name: customName(modes[id], index),
    builtin: false,
  }))
  return [
    { id: MODE_PLAN, name: 'Plan', builtin: true },
    { id: MODE_ACT, name: 'Act', builtin: true },
    ...custom,
  ]
}

/**
 * Which track a committed selection belongs to.
 *
 * `mode` is only a tie-breaker: when several tracks resolve to the same route (or
 * all leave the effort open), the selection cannot distinguish them, and the
 * committed plan mode names the track the user is looking at. Should a custom
 * mode collide with both built-ins, the built-ins still win the tie so the chip
 * never starts calling a Plan selection by a custom name.
 *
 * @param selection - the Host's committed `modelSelection.next` value.
 * @param config - the plugin configuration.
 * @param path - the session's workspace root.
 * @param mode - committed plan mode, used only to break a tie.
 * @returns a track id, or null when the selection matches none of them.
 */
export function sessionTrack(selection, config, path, mode) {
  const current = normalizeRoute(selection)
  if (current === null) return null
  const matches = tracksOf(config).filter((track) => {
    const resolved = resolveTarget(config, path, track.id)
    return resolved.kind === 'route' && sameTrack(current, resolved.route)
  })
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0].id
  const preferred = mode === MODE_PLAN ? MODE_PLAN : MODE_ACT
  const named = matches.find((track) => track.id === preferred)
  return named === undefined ? matches[0].id : named.id
}

/**
 * Decide whether entering plan mode should switch the selection.
 *
 * This is a *soft* switch: a route that is already the plan track is left
 * alone, so a user who hand-picked plan + another effort keeps that effort.
 *
 * A custom mode is not the plan track, so entering plan mode does replace one.
 * That is deliberate: custom modes are manual picks with no rule of their own,
 * and "enter plan mode" is a request to plan with the plan route.
 *
 * @param input.enabled - whether automatic switching is on.
 * @param input.config - the plugin configuration.
 * @param input.path - the session's workspace root.
 * @param input.current - the committed selection, or null.
 * @param input.mode - committed plan mode, used only to break a tie.
 * @returns `{action:'select',track,route,scope}` or `{action:'pass',reason}`.
 */
export function switchPlan({ enabled, config, path, current, mode }) {
  if (enabled !== true) return { action: 'pass', reason: 'disabled' }
  const target = resolveTarget(config, path, MODE_PLAN)
  if (target.kind === 'off') return { action: 'pass', reason: 'project-off' }
  if (target.kind !== 'route') return { action: 'pass', reason: 'route-incomplete' }
  if (sessionTrack(current, config, path, mode) === MODE_PLAN) {
    return { action: 'pass', reason: 'on-track' }
  }
  return { action: 'select', track: MODE_PLAN, route: target.route, scope: target.scope }
}

/**
 * Decide whether an approved plan must switch the selection to Act.
 *
 * This is the one *hard* rule: it ignores which track the selection is on and
 * forces the configured Act route, including its reasoning effort. Without this
 * the approval would leave the session on whatever the user picked in plan
 * mode, and "carry out the plan" would run on the planning model.
 *
 * It overrides a custom mode for the same reason, and the comparison below is
 * already exact (`sameSelection`), so a custom mode that happens to name the Act
 * route still costs no event.
 *
 * @param input.enabled - whether automatic switching is on.
 * @param input.config - the plugin configuration.
 * @param input.path - the session's workspace root.
 * @param input.current - the committed selection, or null.
 * @returns `{action:'select',track,route,scope}` or `{action:'pass',reason}`.
 */
export function switchActOnApproval({ enabled, config, path, current }) {
  if (enabled !== true) return { action: 'pass', reason: 'disabled' }
  const target = resolveTarget(config, path, MODE_ACT)
  if (target.kind === 'off') return { action: 'pass', reason: 'project-off' }
  if (target.kind !== 'route') return { action: 'pass', reason: 'route-incomplete' }
  const stored = normalizeRoute(current)
  if (stored !== null && sameSelection(stored, target.route)) {
    return { action: 'pass', reason: 'already-selected' }
  }
  return { action: 'select', track: MODE_ACT, route: target.route, scope: target.scope }
}
