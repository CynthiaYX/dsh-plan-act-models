/**
 * Per-mode system instructions.
 *
 * A "mode" here is a *track* — `plan`, `act`, or the id of a user-defined mode —
 * exactly what the dropdown and `lib/routing.mjs` already talk about. The user
 * may attach one piece of prose to each track; while that track is the one the
 * session sits on, the prose is contributed to the system prompt, so switching
 * modes also switches the role the model is asked to play.
 *
 * Nothing here imports the Host: the section text is a pure function of the
 * configuration, the workspace path and the session's committed selection, so
 * `test/mode-prompt.test.mjs` exercises it without a running Harness.
 *
 * Two details are load-bearing and deliberate:
 *
 * - `{{` is rewritten to `{ {`. The Host's prompt renderer interpolates
 *   `{{name}}` references and *throws* on an unknown one, which would fail the
 *   whole request; older Hosts cannot opt out of interpolation, so a user's
 *   braces must never survive as a pair.
 * - The instruction is capped. A system prompt is a scarce, cache-sensitive
 *   budget, and a pasted document must not silently become part of every
 *   request in the session.
 */
import {
  MODE_ACT,
  MODE_PLAN,
  customName,
  modesOf,
  normalizeRoute,
  resolveTarget,
  sameTrack,
  tracksOf,
  unref,
} from './routing.mjs'

/** Longest instruction kept from one mode, in characters. */
export const PROMPT_LIMIT = 4000

/**
 * Section name and order.
 *
 * The name carries the plugin prefix so it can never collide with a Host slot
 * (`deployment:persona`, `plan:policy`, …). The order is a fixed number rather
 * than `getSectionOrder()`: the two Host generations this plugin runs on place
 * the same slots at different numbers (plan policy 50 vs 500, tool guidance
 * 100+ vs 1000+), so one fixed number cannot sit between them in both. 900 is
 * chosen to follow the plan policy on either Host; on the older one it also
 * follows the tool guidance, on the newer one it precedes it. Being last is
 * harmless — the instruction is prose about the role, not a tool rule.
 */
export const PROMPT_SECTION = 'plan-act-models:mode-instruction'
export const PROMPT_ORDER = 900

/** Longest mode name quoted in the instruction's framing line. */
const NAME_LIMIT = 60

/** One sentence naming the mode; the user's own prose follows it. */
function frame(name) {
  return `Mode "${name}" is active for this session. Apply its instruction, which follows, to every response.`
}

/**
 * Make user text safe for the Host's prompt renderer.
 *
 * Trailing whitespace is dropped, a `{{` pair is split so no interpolation is
 * attempted, and the result is capped.
 *
 * @param value - the configured instruction (anything else is treated as empty).
 * @param limit - character cap; defaults to {@link PROMPT_LIMIT}.
 * @returns `{ text, truncated }`; `text` is `''` when there is nothing to add.
 */
export function sanitizePrompt(value, limit = PROMPT_LIMIT) {
  const raw = typeof value === 'string' ? value : ''
  const trimmed = raw.trim()
  if (trimmed === '') return { text: '', truncated: false }
  const safe = trimmed.replace(/\{\{/g, '{ {')
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : PROMPT_LIMIT
  if (safe.length <= cap) return { text: safe, truncated: false }
  return { text: safe.slice(0, cap), truncated: true }
}

/**
 * A mode name reduced to one safe line.
 *
 * A name is shown inside a quoted sentence in the system prompt, so newlines and
 * braces are handled the same way the instruction body handles them.
 *
 * @param value - the configured name.
 * @returns the flattened name, or `''`.
 */
export function safeModeName(value) {
  const raw = typeof value === 'string' ? value : ''
  const flat = raw.replace(/\s+/g, ' ').trim().replace(/\{\{/g, '{ {')
  if (flat === '') return ''
  return flat.length <= NAME_LIMIT ? flat : `${flat.slice(0, NAME_LIMIT - 1)}…`
}

/**
 * The instruction stored for one track.
 *
 * @param config - the plugin configuration.
 * @param track - `plan` | `act` | a custom mode id.
 * @returns the raw string, or `''` when the track has none.
 */
export function modePrompt(config, track) {
  if (typeof track !== 'string' || track === '') return ''
  const table = unref(config?.prompts)
  if (table === null || typeof table !== 'object') return ''
  const value = unref(table[track])
  return typeof value === 'string' ? value : ''
}

/**
 * The display name of one track, using the same words as the dropdown.
 *
 * @param config - the plugin configuration.
 * @param track - `plan` | `act` | a custom mode id.
 * @returns `Plan`, `Act`, the mode's name, or `''` for an unknown id.
 */
export function modeName(config, track) {
  if (track === MODE_PLAN) return 'Plan'
  if (track === MODE_ACT) return 'Act'
  const modes = modesOf(config)
  const index = Object.keys(modes).indexOf(track)
  if (index < 0) return ''
  return safeModeName(customName(modes[track], index))
}

/**
 * The complete section text for one track, framed and sanitized.
 *
 * @param input.config - the plugin configuration.
 * @param input.track - the track the session is on, or null.
 * @param input.limit - character cap for the user's part.
 * @returns `{ text, truncated }`; `text` is `''` when the track adds nothing.
 */
export function modeInstruction({ config, track, limit } = {}) {
  const name = modeName(config, track)
  if (name === '') return { text: '', truncated: false }
  const body = sanitizePrompt(modePrompt(config, track), limit)
  if (body.text === '') return { text: '', truncated: false }
  return { text: `${frame(name)}\n\n${body.text}`, truncated: body.truncated }
}

/**
 * Whether two routes could be mistaken for one another.
 *
 * The Host records a selection as provider + model + effort, so two tracks that
 * resolve to the same pair are indistinguishable from the log alone. An empty
 * configured effort follows the model default — the Host writes the resolved
 * default back into the selection — so it is compatible with any effort.
 *
 * @param left - a configured or committed route.
 * @param right - the other route.
 * @returns whether the pair may collide.
 */
export function confusable(left, right) {
  const a = normalizeRoute(left)
  const b = normalizeRoute(right)
  if (a === null || b === null) return false
  if (a.provider !== b.provider || a.model !== b.model) return false
  if (a.reasoningEffort === undefined || b.reasoningEffort === undefined) return true
  return a.reasoningEffort === b.reasoningEffort
}

/**
 * Every track whose route the committed selection could belong to.
 *
 * @param config - the plugin configuration.
 * @param path - the session's workspace root.
 * @param selection - the committed selection, or null.
 * @returns track ids in dropdown order.
 */
export function matchingTracks(config, path, selection) {
  const current = normalizeRoute(selection)
  if (current === null) return []
  return tracksOf(config)
    .filter((track) => {
      const resolved = resolveTarget(config, path, track.id)
      return resolved.kind === 'route' && sameTrack(current, resolved.route)
    })
    .map((track) => track.id)
}

/**
 * Which track the session is on, honouring the last selection it actually made.
 *
 * `remembered` is the track a previous `model/selection` event resolved to. It
 * only wins while it still matches, which is what keeps two tracks sharing one
 * route distinguishable: the log cannot tell them apart, but the last decision
 * the user made can. Without it this is `sessionTrack` — plan/act win a tie and
 * `planActive` breaks it.
 *
 * @param input.config - the plugin configuration.
 * @param input.path - the session's workspace root.
 * @param input.selection - the committed selection, or null.
 * @param input.planActive - whether plan mode is on, used only to break a tie.
 * @param input.remembered - the previously resolved track, if any.
 * @returns a track id, or null when the selection matches none of them.
 */
export function resolveMode({ config, path, selection, planActive, remembered } = {}) {
  const matches = matchingTracks(config, path, selection)
  if (matches.length === 0) return null
  if (typeof remembered === 'string' && matches.includes(remembered)) return remembered
  if (matches.length === 1) return matches[0]
  const preferred = planActive === true ? MODE_PLAN : MODE_ACT
  return matches.includes(preferred) ? preferred : matches[0]
}

/**
 * Groups of tracks whose routes cannot be told apart.
 *
 * Reported by the settings page (so a user does not wonder why one of two
 * identical routes never gets its instruction) and once per configuration by
 * the Host. Groups are transitive: A↔B and B↔C also put A↔C in one group.
 *
 * @param config - the plugin configuration.
 * @param path - the session's workspace root, which may narrow the routes.
 * @returns arrays of track ids, each with at least two members.
 */
export function routeConflicts(config, path) {
  const order = tracksOf(config).map((track) => track.id)
  const entries = []
  for (const id of order) {
    const resolved = resolveTarget(config, path, id)
    if (resolved.kind === 'route') entries.push({ id, route: resolved.route })
  }
  const groups = []
  for (const entry of entries) {
    const hits = groups.filter((group) => group.some((other) => confusable(other.route, entry.route)))
    if (hits.length === 0) {
      groups.push([entry])
      continue
    }
    const merged = [entry]
    for (const group of hits) {
      merged.push(...group)
      groups.splice(groups.indexOf(group), 1)
    }
    groups.push(merged)
  }
  return groups
    .filter((group) => group.length > 1)
    // Merging puts the newest member first; report tracks in dropdown order so
    // the message reads the way the menu does.
    .map((group) => group.map((item) => item.id).sort((left, right) => order.indexOf(left) - order.indexOf(right)))
}
