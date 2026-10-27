/**
 * The composer control must agree with the Host, and say `模式：模型`.
 *
 * Two independent things can rot here, so both are pinned:
 *
 * 1. **Mirror drift.** `client.js` is a classic script served to the page, so it
 *    cannot import `lib/routing.mjs`; it carries a hand-written copy of
 *    `resolveTarget` and `sessionTrack`. A one-sided edit would leave the
 *    dropdown describing a track the Host never takes — the exact failure this
 *    file exists to catch. The region between `#region plan-act-view` and
 *    `#endregion` is extracted from the real source and compared with the real
 *    functions over a matrix.
 * 2. **Label text.** The user asked for `模式：模型` with a full-width colon;
 *    the format is asserted on the real `routeLabel` output, not by grep.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { resolveTarget, sessionTrack, customName, customTracks } from '../lib/routing.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Pull the mirrored decision table out of the bundle source.
 *
 * Fails loudly when the sentinels are gone: an empty extraction would otherwise
 * make every comparison below vacuously pass.
 * @returns the evaluated region's globals.
 */
function loadMirror() {
  const start = source.indexOf('// #region plan-act-view')
  const end = source.indexOf('// #endregion plan-act-view')
  assert.ok(start >= 0, 'client.js must keep the `#region plan-act-view` sentinel')
  assert.ok(end > start, 'client.js must keep the matching `#endregion plan-act-view` sentinel')
  const region = source.slice(start, end)
  const evaluate = new Function(
    `${region}
     return {
       mirrorResolve,
       mirrorRoute,
       mirrorKey,
       mirrorMode,
       mirrorSameTrack,
       mirrorTrackOf,
       mirrorModes,
       mirrorModeName,
       mirrorCustomTracks,
       mirrorTracks,
       routeLabel,
       routeDetail,
       routeTitle,
       customLabel,
       customTitle,
       routeName,
       LABEL_SEPARATOR,
       MODE_WORDS,
       CUSTOM_TONE,
     }`,
  )
  return evaluate()
}

const mirror = loadMirror()

/** The inputs the two implementations have to agree on. */
const MATRIX = [
  { name: 'complete global pair', config: pair(), path: 'C:/work', mode: 'plan' },
  { name: 'act side of a complete pair', config: pair(), path: 'C:/work', mode: 'act' },
  {
    name: 'effort-only global route',
    config: { plan: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
    path: '',
    mode: 'plan',
  },
  {
    name: 'missing model blocks',
    config: { plan: { provider: 'p', model: '' } },
    path: '',
    mode: 'plan',
  },
  {
    name: 'missing provider blocks',
    config: { plan: { model: 'm' } },
    path: '',
    mode: 'act',
  },
  { name: 'no config at all', config: undefined, path: 'C:/work', mode: 'plan' },
  { name: 'null config', config: null, path: 'C:/work', mode: 'act' },
  {
    name: 'padded provider and model are trimmed',
    config: { plan: { provider: '  p  ', model: ' m ', reasoningEffort: ' max ' } },
    path: '',
    mode: 'plan',
  },
  {
    name: 'blank effort collapses to no effort',
    config: { plan: { provider: 'p', model: 'm', reasoningEffort: '   ' } },
    path: '',
    mode: 'plan',
  },
  {
    name: 'project override wins over the global pair',
    config: pair({ 'D:/Repo': override() }),
    path: 'd:/repo/',
    mode: 'plan',
  },
  {
    name: 'override with backslashes in the key',
    config: pair({ 'D:\\Repo\\': override() }),
    path: 'd:/repo',
    mode: 'act',
  },
  {
    name: 'incomplete override blocks that project only',
    config: pair({ 'd:/repo': { mode: 'override', plan: { provider: '', model: '' } } }),
    path: 'd:/repo',
    mode: 'plan',
  },
  {
    name: 'incomplete override leaves act alone',
    config: pair({ 'd:/repo': { mode: 'override', plan: { provider: '', model: '' } } }),
    path: 'd:/repo',
    mode: 'act',
  },
  { name: 'project set to off', config: pair({ 'd:/repo': { mode: 'off' } }), path: 'd:/repo', mode: 'plan' },
  {
    name: 'inherit falls back to the global pair',
    config: pair({ 'd:/repo': { mode: 'inherit' } }),
    path: 'd:/repo',
    mode: 'plan',
  },
  {
    name: 'unknown project mode reads as inherit',
    config: pair({ 'd:/repo': { mode: 'nonsense', plan: { provider: 'x', model: 'y' } } }),
    path: 'd:/repo',
    mode: 'plan',
  },
  {
    name: 'a project key that does not match stays global',
    config: pair({ 'd:/other': { mode: 'off' } }),
    path: 'd:/repo',
    mode: 'plan',
  },
  {
    name: 'projects as a volatile cell',
    config: { plan: { provider: 'p', model: 'm' }, projects: { get: () => ({ 'd:/repo': override() }) } },
    path: 'd:/repo',
    mode: 'plan',
  },
  {
    name: 'route as a volatile cell',
    config: { plan: { get: () => ({ provider: 'p', model: 'm' }) } },
    path: '',
    mode: 'plan',
  },
  {
    name: 'project entry as a volatile cell',
    config: { plan: { provider: 'p', model: 'm' }, projects: { 'd:/repo': { get: () => override() } } },
    path: 'd:/repo',
    mode: 'act',
  },
  {
    name: 'plain value cell',
    config: { plan: { value: { provider: 'p', model: 'm', reasoningEffort: 'high' } } },
    path: '',
    mode: 'plan',
  },
  {
    name: 'empty workspace path never matches a project',
    config: pair({ '': { mode: 'off' } }),
    path: '',
    mode: 'plan',
  },
  {
    name: 'trailing separators only',
    config: pair({ 'd:/': override() }),
    path: 'D:/',
    mode: 'plan',
  },
  // --- custom modes ---
  {
    name: 'custom mode resolves from the global table',
    config: { ...pair(), modes: { m1: { name: '审查', provider: 'q', model: 'n', reasoningEffort: 'low' } } },
    path: '',
    mode: 'm1',
  },
  {
    name: 'custom mode ignores a project override',
    config: {
      ...pair({ 'd:/repo': override() }),
      modes: { m1: { name: '审查', provider: 'q', model: 'n', reasoningEffort: 'low' } },
    },
    path: 'd:/repo',
    mode: 'm1',
  },
  {
    name: 'custom mode is silenced by a dead project',
    config: {
      ...pair({ 'd:/repo': { mode: 'off' } }),
      modes: { m1: { name: '审查', provider: 'q', model: 'n' } },
    },
    path: 'd:/repo',
    mode: 'm1',
  },
  {
    name: 'incomplete custom mode blocks alone',
    config: { ...pair(), modes: { m1: { name: '审查', provider: 'q', model: '' } } },
    path: '',
    mode: 'm1',
  },
  {
    name: 'custom mode without a name still resolves',
    config: { ...pair(), modes: { m1: { provider: 'q', model: 'n' } } },
    path: '',
    mode: 'm1',
  },
  {
    name: 'an id that is not in the table',
    config: { ...pair(), modes: { m1: { provider: 'q', model: 'n' } } },
    path: '',
    mode: 'm2',
  },
  {
    name: 'modes as a volatile cell',
    config: { ...pair(), modes: { get: () => ({ m1: { name: '审查', provider: 'q', model: 'n' } }) } },
    path: '',
    mode: 'm1',
  },
  {
    name: 'a modes cell holding an array is ignored',
    config: { ...pair(), modes: [] },
    path: '',
    mode: 'm1',
  },
]

/**
 * The selections to run both `sessionTrack` implementations over.
 *
 * The interesting values are the near-misses: same provider+model with another
 * effort, same effort with another model, and a route neither track names.
 */
const SELECTIONS = [
  null,
  undefined,
  {},
  { provider: 'p', model: 'm', reasoningEffort: 'max' },
  { provider: 'p', model: 'm', reasoningEffort: 'high' },
  { provider: 'p', model: 'm' },
  { provider: 'p', model: 'm', reasoningEffort: 'low' },
  { provider: 'p', model: 'zzz', reasoningEffort: 'max' },
  { provider: 'q', model: 'n', reasoningEffort: 'max' },
  { provider: 'q', model: 'n' },
  { provider: '  p  ', model: ' m ', reasoningEffort: ' max ' },
]

function pair(projects) {
  return {
    plan: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    act: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    ...(projects === undefined ? {} : { projects }),
  }
}

function override() {
  return {
    mode: 'override',
    plan: { provider: 'q', model: 'n', reasoningEffort: 'max' },
    act: { provider: 'q', model: 'n' },
  }
}

/** The fields the control actually renders from. */
function comparable(target) {
  return { kind: target.kind, route: target.route ?? null, scope: target.scope, projectKey: target.projectKey ?? null }
}

test('the mirrored resolver matches lib/routing.mjs on every input', () => {
  for (const item of MATRIX) {
    assert.deepEqual(
      comparable(mirror.mirrorResolve(item.config, item.path, item.mode)),
      comparable(resolveTarget(item.config, item.path, item.mode)),
      `mirror diverged from resolveTarget on: ${item.name}`,
    )
  }
})

test('the mirrored track finder matches lib/routing.mjs on every combination', () => {
  const configs = [
    pair(),
    pair({ 'd:/repo': override() }),
    pair({ 'd:/repo': { mode: 'off' } }),
    { plan: { provider: 'p', model: 'm' }, act: { provider: 'p', model: 'm' }, projects: {} },
    { plan: { provider: 'p', model: 'm', reasoningEffort: 'max' }, act: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
    {},
    undefined,
    // Custom modes: one that owns its own route, one that collides with a
    // built-in, one that is incomplete, one with no name at all.
    { ...pair(), modes: { m1: { name: '审查', provider: 'q', model: 'n', reasoningEffort: 'low' } } },
    { ...pair(), modes: { m1: { name: '也是 Plan', provider: 'p', model: 'm', reasoningEffort: 'max' } } },
    { ...pair(), modes: { m1: { name: '待补', provider: 'q', model: '' } } },
    { ...pair(), modes: { m1: { provider: 'q', model: 'n' } } },
    {
      ...pair(),
      modes: { m1: { name: '甲', provider: 'q', model: 'n' }, m2: { name: '乙', provider: 'q', model: 'n' } },
    },
  ]
  const paths = ['', 'C:/work', 'd:/repo', 'd:/repo/']
  const modes = ['plan', 'act', 'm1', 'm2']
  for (const config of configs) {
    for (const path of paths) {
      for (const mode of modes) {
        for (const selection of SELECTIONS) {
          assert.equal(
            mirror.mirrorTrackOf(selection, config, path, mode),
            sessionTrack(selection, config, path, mode),
            `mirror diverged from sessionTrack for ${JSON.stringify(selection)} with `
            + `${JSON.stringify(config)} at ${path} in ${mode}`,
          )
        }
      }
    }
  }
})

test('the mirrored helpers agree with their originals in isolation', () => {
  assert.equal(mirror.mirrorKey('D:\\Work\\Repo\\'), 'd:/work/repo')
  assert.equal(mirror.mirrorKey(''), '')
  assert.equal(mirror.mirrorMode(undefined), 'inherit')
  assert.equal(mirror.mirrorMode({ mode: 'off' }), 'off')
  assert.deepEqual(mirror.mirrorRoute({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
  assert.equal(mirror.mirrorRoute({ provider: 'p' }), null)
})

test('the mirrored custom-mode table matches lib/routing.mjs entry for entry', () => {
  const configs = [
    {},
    undefined,
    { modes: [] },
    { modes: { m1: { name: '审查', provider: 'q', model: 'n' } } },
    { modes: { m1: { name: '  ', provider: 'q', model: 'n' }, m2: { provider: 'q', model: '' } } },
    { modes: { get: () => ({ m1: { name: '审查', provider: 'q', model: 'n' } }) } },
  ]
  for (const config of configs) {
    assert.deepEqual(
      mirror.mirrorCustomTracks(config),
      customTracks(config),
      `mirror diverged from customTracks for ${JSON.stringify(config)}`,
    )
    // The name fallback is the one string a user actually reads, so it is pinned
    // on its own rather than only through the table above.
    for (const [index, id] of Object.keys(mirror.mirrorModes(config)).entries()) {
      assert.equal(
        mirror.mirrorModeName(mirror.mirrorModes(config)[id], index),
        customName(mirror.mirrorModes(config)[id], index),
        `mirror diverged from customName at index ${index}`,
      )
    }
  }
})

test('the mirrored track list is plan, act, then the custom modes', () => {
  const tracks = mirror.mirrorTracks({ modes: { m1: { name: '审查', provider: 'q', model: 'n' } } })
  assert.deepEqual(tracks.map((track) => track.id), ['plan', 'act', 'm1'])
  assert.equal(tracks[2].name, '审查')
  assert.equal(tracks[2].builtin, false)
  assert.deepEqual(mirror.mirrorTracks({}), [
    { id: 'plan', name: 'Plan', builtin: true },
    { id: 'act', name: 'Act', builtin: true },
  ])
})

test('a custom mode labels itself with the user’s own name', () => {
  const config = { modes: { m1: { name: '审查', provider: 'q', model: 'n', reasoningEffort: 'low' } } }
  const resolved = mirror.mirrorResolve(config, '', 'm1')
  assert.equal(mirror.routeLabel('m1', resolved, null, '审查'), '审查：n')
  // Without the display name it still says something: never `undefined：n`.
  assert.equal(mirror.routeLabel('m1', resolved, null), 'm1：n')
  // An incomplete custom mode reads as unconfigured, not as an empty model.
  const broken = mirror.mirrorResolve({ modes: { m1: { name: '待补', provider: 'q', model: '' } } }, '', 'm1')
  assert.equal(mirror.routeLabel('m1', broken, null, '待补'), '待补：未配置')
})

test('a custom mode has one tone of its own', () => {
  assert.equal(mirror.CUSTOM_TONE, 'mode')
  // The tone must not collide with the two built-ins or the placeholder, which
  // is what keeps a menu with a dozen entries scannable.
  assert.notEqual(mirror.CUSTOM_TONE, 'plan')
  assert.notEqual(mirror.CUSTOM_TONE, 'act')
  assert.notEqual(mirror.CUSTOM_TONE, 'custom')
})

test('mirrorSameTrack follows the effort only when the route pins one', () => {
  assert.equal(mirror.mirrorSameTrack({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'max' }), false)
  assert.equal(mirror.mirrorSameTrack({ provider: 'p', model: 'm', reasoningEffort: 'max' }, { provider: 'p', model: 'm' }), true)
  assert.equal(mirror.mirrorSameTrack({ provider: 'p', model: 'm', reasoningEffort: 'max' }, { provider: 'p', model: 'm', reasoningEffort: 'max' }), true)
  assert.equal(mirror.mirrorSameTrack({ provider: 'p', model: 'n' }, { provider: 'p', model: 'm' }), false)
})

test('the control reads `模式：模型`', () => {
  assert.equal(mirror.LABEL_SEPARATOR, '：', 'the separator is the full-width colon')
  const config = pair()
  const catalog = { groups: [{ id: 'p', models: [{ id: 'm', name: 'DeepSeek V4.1 Flash' }] }] }

  assert.equal(
    mirror.routeLabel('plan', mirror.mirrorResolve(config, '', 'plan'), catalog),
    'Plan：DeepSeek V4.1 Flash',
  )
  assert.equal(
    mirror.routeLabel('act', mirror.mirrorResolve(config, '', 'act'), catalog),
    'Act：DeepSeek V4.1 Flash',
  )
})

test('an unknown model falls back to its id instead of rendering "undefined"', () => {
  const config = { plan: { provider: 'p', model: 'unknown-model' } }
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve(config, '', 'plan'), null), 'Plan：unknown-model')
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve(config, '', 'plan'), {}), 'Plan：unknown-model')
})

test('the two degraded states say what they are, never a stale model', () => {
  const config = pair({ 'd:/repo': { mode: 'off' } })
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve(config, 'd:/repo', 'plan'), null), 'Plan：此项目已停用')
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve({}, '', 'plan'), null), 'Plan：未配置')
})

test('an off switch no longer changes the label: only automatic switching stops', () => {
  // The previous version rendered `Act：已关闭` when `enabled` was false, which
  // claimed the dropdown was dead. It is not: a manual pick always works.
  const label = mirror.routeLabel('act', mirror.mirrorResolve(pair(), '', 'act'), null)
  assert.equal(label, 'Act：m')
  assert.doesNotMatch(label, /已关闭/)
})

test('the placeholder option names the model the session is actually on', () => {
  const catalog = { groups: [{ id: 'p', models: [{ id: 'm', name: 'DeepSeek V4.1 Flash' }] }] }
  assert.equal(
    mirror.customLabel({ provider: 'p', model: 'm', reasoningEffort: 'high' }, catalog),
    '自定义：DeepSeek V4.1 Flash',
  )
  assert.equal(mirror.customLabel(null, catalog), '自定义：未选择')
  assert.match(mirror.customLabel({ provider: 'p', model: 'm' }, null), /^自定义：m$/)
})

test('the hover title carries the exact route plus where it came from', () => {
  const config = pair({ 'd:/repo': override() })
  const title = mirror.routeTitle('plan', mirror.mirrorResolve(config, 'd:/repo', 'plan'), null)
  assert.match(title, /^Plan：n — q\/n \(max\) · 项目覆盖：/)
  assert.match(mirror.routeTitle('act', mirror.mirrorResolve(pair(), '', 'act'), null), /· 全局配置$/)
  assert.equal(mirror.routeDetail(mirror.mirrorResolve({}, '', 'plan')), null)
})

test('the placeholder title spells the ids out', () => {
  assert.match(mirror.customTitle({ provider: 'p', model: 'm', reasoningEffort: 'low' }), /^自定义 — p\/m \(low\)$/)
  assert.match(mirror.customTitle(null), /^自定义 — 当前会话还没有选定模型$/)
})
