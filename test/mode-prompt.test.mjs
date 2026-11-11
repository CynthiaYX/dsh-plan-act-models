/**
 * Per-mode instructions: what goes into the system prompt, and for which mode.
 *
 * The module is pure, so everything here is plain values — the section text the
 * Host assembles, the sanitizing that keeps it from breaking prompt rendering,
 * and the track resolution that decides which mode a session is on when two
 * modes share a route.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROMPT_LIMIT,
  PROMPT_ORDER,
  PROMPT_SECTION,
  confusable,
  matchingTracks,
  modeInstruction,
  modeName,
  modePrompt,
  resolveMode,
  routeConflicts,
  safeModeName,
  sanitizePrompt,
} from '../lib/mode-prompt.mjs'

const MODEL = 'deepseek-v4.1-flash'
const PLAN_ROUTE = { provider: 'cline-pass', model: MODEL, reasoningEffort: 'max' }
const ACT_ROUTE = { provider: 'cline-pass', model: MODEL, reasoningEffort: 'high' }
const REVIEW_ROUTE = { provider: 'local', model: 'reviewer', reasoningEffort: 'low' }

function config(overrides = {}) {
  return {
    enabled: true,
    plan: PLAN_ROUTE,
    act: ACT_ROUTE,
    modes: {},
    projects: {},
    prompts: {},
    ...overrides,
  }
}

/** A config with one custom mode `m1` named 审查 on its own route. */
function reviewed(overrides = {}) {
  return config({
    modes: { m1: { name: '审查', ...REVIEW_ROUTE } },
    ...overrides,
  })
}

// --- sanitizing ------------------------------------------------------------

test('a blank or non-string instruction yields no section at all', () => {
  for (const value of ['', '   ', '\n\n', null, undefined, 42, {}]) {
    assert.deepEqual(sanitizePrompt(value), { text: '', truncated: false }, `value: ${String(value)}`)
  }
})

test('an instruction is trimmed, and its braces are split so rendering cannot interpolate', () => {
  assert.deepEqual(sanitizePrompt('  只报告问题  '), { text: '只报告问题', truncated: false })
  // The Host throws on an unknown `{{name}}`; splitting the pair keeps the text
  // readable while making interpolation impossible.
  assert.deepEqual(sanitizePrompt('用 {{file}} 占位'), { text: '用 { {file}} 占位', truncated: false })
})

test('a lone or unpaired brace is left exactly as the user typed it', () => {
  assert.equal(sanitizePrompt('{ 一个花括号').text, '{ 一个花括号')
  assert.equal(sanitizePrompt('结尾两个 }}').text, '结尾两个 }}')
})

test('the instruction is capped and reports that it was cut', () => {
  const long = 'x'.repeat(PROMPT_LIMIT + 20)
  const { text, truncated } = sanitizePrompt(long)
  assert.equal(text.length, PROMPT_LIMIT)
  assert.equal(truncated, true)
  // The cap applies after trimming, so trailing spaces never count against it.
  assert.deepEqual(sanitizePrompt(`${'y'.repeat(PROMPT_LIMIT)}   `), {
    text: 'y'.repeat(PROMPT_LIMIT),
    truncated: false,
  })
})

test('a caller may pass its own cap, including a nonsense one', () => {
  assert.deepEqual(sanitizePrompt('abcdef', 3), { text: 'abc', truncated: true })
  assert.equal(sanitizePrompt('abcdef', 0).text.length, PROMPT_LIMIT > 6 ? 6 : PROMPT_LIMIT)
  assert.equal(sanitizePrompt('abcdef', Number.NaN).text, 'abcdef')
})

test('a mode name is flattened to one safe line', () => {
  assert.equal(safeModeName('  审查\n  代码 '), '审查 代码')
  assert.equal(safeModeName('{{x}}'), '{ {x}}')
  assert.equal(safeModeName(''), '')
  assert.equal(safeModeName(undefined), '')
  const long = safeModeName('名'.repeat(80))
  assert.equal(long.length, 60, 'a long name is shortened to the cap')
  assert.ok(long.endsWith('…'))
})

// --- reading configuration -------------------------------------------------

test('modePrompt reads one track and ignores anything that is not a string', () => {
  const cfg = config({ prompts: { plan: '先调研', m1: '只报告问题', act: 7 } })
  assert.equal(modePrompt(cfg, 'plan'), '先调研')
  assert.equal(modePrompt(cfg, 'm1'), '只报告问题')
  assert.equal(modePrompt(cfg, 'act'), '')
  assert.equal(modePrompt(cfg, 'unknown'), '')
  assert.equal(modePrompt(config(), 'plan'), '')
  assert.equal(modePrompt(undefined, 'plan'), '')
})

test('modePrompt unwraps a volatile cell, like every other config read', () => {
  const cfg = config({ prompts: { get: () => ({ plan: '来自单元格' }) } })
  assert.equal(modePrompt(cfg, 'plan'), '来自单元格')
})

test('modeName speaks the same words as the dropdown', () => {
  const cfg = reviewed()
  assert.equal(modeName(cfg, 'plan'), 'Plan')
  assert.equal(modeName(cfg, 'act'), 'Act')
  assert.equal(modeName(cfg, 'm1'), '审查')
  assert.equal(modeName(cfg, 'ghost'), '')
})

test('an unnamed custom mode is named by its position, as the menu does', () => {
  const cfg = config({ modes: { a: { ...REVIEW_ROUTE }, b: { name: '写文档', ...REVIEW_ROUTE } } })
  assert.equal(modeName(cfg, 'a'), '模式 1')
  assert.equal(modeName(cfg, 'b'), '写文档')
})

// --- the section text ------------------------------------------------------

test('an instruction arrives framed by the mode it belongs to', () => {
  const { text, truncated } = modeInstruction({ config: reviewed({ prompts: { m1: '只报告问题' } }), track: 'm1' })
  assert.equal(truncated, false)
  const [first, body] = text.split('\n\n')
  assert.match(first, /^Mode "审查" is active for this session\./)
  assert.equal(body, '只报告问题')
})

test('no instruction, no name, or no track means no section', () => {
  assert.deepEqual(modeInstruction({ config: reviewed(), track: 'm1' }), { text: '', truncated: false })
  assert.deepEqual(
    modeInstruction({ config: reviewed({ prompts: { ghost: '孤儿' } }), track: 'ghost' }),
    { text: '', truncated: false },
  )
  assert.deepEqual(modeInstruction({ config: reviewed({ prompts: { m1: 'x' } }), track: null }), {
    text: '',
    truncated: false,
  })
  assert.deepEqual(modeInstruction({}), { text: '', truncated: false })
})

test('the plan and act tracks carry instructions too', () => {
  const cfg = config({ prompts: { plan: '先给方案', act: '直接改代码' } })
  assert.match(modeInstruction({ config: cfg, track: 'plan' }).text, /^Mode "Plan" is active[^\n]*\n\n先给方案$/)
  assert.match(modeInstruction({ config: cfg, track: 'act' }).text, /^Mode "Act" is active[^\n]*\n\n直接改代码$/)
})

test('truncation survives framing and is reported to the caller', () => {
  const long = 'z'.repeat(PROMPT_LIMIT + 5)
  const { text, truncated } = modeInstruction({ config: config({ prompts: { plan: long } }), track: 'plan' })
  assert.equal(truncated, true)
  assert.ok(text.endsWith('z'))
})

test('the section name and order cannot collide with a Host slot', () => {
  assert.equal(PROMPT_SECTION, 'plan-act-models:mode-instruction')
  // Two Host generations number the same slots differently (plan policy 50 vs
  // 500, tool guidance 100+ vs 1000+), so no single number sorts between them
  // on both. 900 follows the plan policy everywhere and stays clear of the
  // deployment persona slots at the very end.
  assert.ok(PROMPT_ORDER > 500 && PROMPT_ORDER < 1000)
})

// --- which mode is the session on -----------------------------------------

test('confusable compares provider and model, and treats an unset effort as any', () => {
  assert.equal(confusable(PLAN_ROUTE, { ...PLAN_ROUTE }), true)
  assert.equal(confusable(PLAN_ROUTE, ACT_ROUTE), false, 'same model, different effort')
  assert.equal(confusable({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'x' }), true)
  assert.equal(confusable(PLAN_ROUTE, { ...PLAN_ROUTE, model: 'other' }), false)
  assert.equal(confusable(null, PLAN_ROUTE), false)
})

test('matchingTracks lists every track a selection could belong to', () => {
  const cfg = reviewed()
  assert.deepEqual(matchingTracks(cfg, '', PLAN_ROUTE), ['plan'])
  assert.deepEqual(matchingTracks(cfg, '', ACT_ROUTE), ['act'])
  assert.deepEqual(matchingTracks(cfg, '', REVIEW_ROUTE), ['m1'])
  assert.deepEqual(matchingTracks(cfg, '', { provider: 'x', model: 'y' }), [])
  assert.deepEqual(matchingTracks(cfg, '', null), [])
})

test('a project override changes which tracks a selection matches', () => {
  const cfg = config({
    projects: { 'c:/work': { mode: 'override', plan: REVIEW_ROUTE, act: ACT_ROUTE } },
  })
  assert.deepEqual(matchingTracks(cfg, 'C:/work', REVIEW_ROUTE), ['plan'])
  assert.deepEqual(matchingTracks(cfg, 'D:/elsewhere', REVIEW_ROUTE), [])
})

test('a lone match resolves without help, and no match resolves to null', () => {
  const cfg = reviewed()
  assert.equal(resolveMode({ config: cfg, path: '', selection: REVIEW_ROUTE }), 'm1')
  assert.equal(resolveMode({ config: cfg, path: '', selection: { provider: 'x', model: 'y' } }), null)
  assert.equal(resolveMode({}), null)
})

test('the remembered track wins a tie, because the log cannot express one', () => {
  // `m1` is on the same route as plan: the selection alone is ambiguous.
  const cfg = config({
    modes: { m1: { name: '审查', ...PLAN_ROUTE } },
    prompts: { plan: '先给方案', m1: '只报告问题' },
  })
  const selection = { ...PLAN_ROUTE }
  const tie = { config: cfg, path: '', selection }
  // Without memory the built-in wins, exactly as the composer control shows it.
  assert.equal(resolveMode(tie), 'plan')
  assert.equal(resolveMode({ ...tie, planActive: true }), 'plan')
  // With memory the mode the user actually chose wins.
  assert.equal(resolveMode({ ...tie, remembered: 'm1' }), 'm1')
  // A memory that no longer matches the selection is stale and is ignored.
  assert.equal(resolveMode({ ...tie, remembered: 'act' }), 'plan')
})

test('without a remembered track a tie prefers the active built-in track', () => {
  const cfg = config({ modes: { m1: { name: '审查', ...ACT_ROUTE } } })
  const selection = { ...ACT_ROUTE }
  assert.equal(resolveMode({ config: cfg, path: '', selection, planActive: false }), 'act')
  // Only one built-in can win a tie against a custom mode, and the plan flag
  // picks which; a tie never resolves to the custom mode on its own.
  assert.equal(resolveMode({ config: cfg, path: '', selection, planActive: true }), 'act')
})

// --- telling the user about collisions ------------------------------------

test('routeConflicts groups tracks whose routes cannot be told apart', () => {
  const cfg = config({ modes: { m1: { name: '审查', ...PLAN_ROUTE } } })
  assert.deepEqual(routeConflicts(cfg, ''), [['plan', 'm1']])
})

test('a configuration with distinct routes has no conflicts', () => {
  assert.deepEqual(routeConflicts(reviewed(), ''), [])
  assert.deepEqual(routeConflicts(config(), ''), [], 'plan and act differ by effort')
})

test('conflicts are transitive, and a blank effort joins everything it can', () => {
  const cfg = config({
    modes: {
      m1: { name: 'A', provider: 'p', model: 'm' },
      m2: { name: 'B', provider: 'p', model: 'm', reasoningEffort: 'max' },
      m3: { name: 'C', provider: 'p', model: 'm', reasoningEffort: 'max' },
      m4: { name: 'D', provider: 'other', model: 'm' },
    },
  })
  const groups = routeConflicts(cfg, '')
  assert.equal(groups.length, 1)
  assert.deepEqual([...groups[0]].sort(), ['m1', 'm2', 'm3'])
})

test('an unfinished mode never joins a conflict group', () => {
  const cfg = config({ modes: { m1: { name: '空', provider: 'p', model: '' } } })
  assert.deepEqual(routeConflicts(cfg, ''), [])
})

test('a project override can create a conflict that the global config does not have', () => {
  const cfg = config({ projects: { 'c:/work': { mode: 'override', plan: ACT_ROUTE, act: ACT_ROUTE } } })
  assert.deepEqual(routeConflicts(cfg, ''), [])
  assert.deepEqual(routeConflicts(cfg, 'C:/work'), [['plan', 'act']])
})
