/**
 * The composer chip must agree with the Host, and say `模式：模型`.
 *
 * Two independent things can rot here, so both are pinned:
 *
 * 1. **Mirror drift.** `client.js` is a classic script served to the page, so it
 *    cannot import `lib/routing.mjs`; it carries a hand-written copy of
 *    `resolveTarget`. A one-sided edit would leave the chip describing a route
 *    the Host never takes — the exact failure this file exists to catch. The
 *    region between `#region plan-act-view` and `#endregion` is extracted from
 *    the real source and compared with the real `resolveTarget` over a matrix.
 * 2. **Label text.** The user asked for `模式：模型` with a full-width colon;
 *    the format is asserted on the real `routeLabel` output, not by grep.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { resolveTarget } from '../lib/routing.mjs'

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
       routeLabel,
       routeTitle,
       routeName,
       LABEL_SEPARATOR,
       MODE_WORDS,
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

/** The fields the chip actually renders from. */
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

test('the mirrored helpers agree with their originals in isolation', () => {
  assert.equal(mirror.mirrorKey('D:\\Work\\Repo\\'), 'd:/work/repo')
  assert.equal(mirror.mirrorKey(''), '')
  assert.equal(mirror.mirrorMode(undefined), 'inherit')
  assert.equal(mirror.mirrorMode({ mode: 'off' }), 'off')
  assert.deepEqual(mirror.mirrorRoute({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
  assert.equal(mirror.mirrorRoute({ provider: 'p' }), null)
})

test('the chip reads `模式：模型`', () => {
  assert.equal(mirror.LABEL_SEPARATOR, '：', 'the separator is the full-width colon')
  const config = pair()
  const catalog = { groups: [{ id: 'p', models: [{ id: 'm', name: 'DeepSeek V4.1 Flash' }] }] }

  assert.equal(
    mirror.routeLabel('plan', mirror.mirrorResolve(config, '', 'plan'), catalog, true),
    'Plan：DeepSeek V4.1 Flash',
  )
  assert.equal(
    mirror.routeLabel('act', mirror.mirrorResolve(config, '', 'act'), catalog, true),
    'Act：DeepSeek V4.1 Flash',
  )
})

test('an unknown model falls back to its id instead of rendering "undefined"', () => {
  const config = { plan: { provider: 'p', model: 'unknown-model' } }
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve(config, '', 'plan'), null, true), 'Plan：unknown-model')
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve(config, '', 'plan'), {}, true), 'Plan：unknown-model')
})

test('the three degraded states say what they are, never a stale model', () => {
  const config = pair({ 'd:/repo': { mode: 'off' } })
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve(config, 'd:/repo', 'plan'), null, true), 'Plan：此项目已停用')
  assert.equal(mirror.routeLabel('plan', mirror.mirrorResolve({}, '', 'plan'), null, true), 'Plan：未配置')
  assert.equal(mirror.routeLabel('act', mirror.mirrorResolve(config, '', 'act'), null, false), 'Act：已关闭')
})

test('the hover title carries the exact route plus where it came from', () => {
  const config = pair({ 'd:/repo': override() })
  const title = mirror.routeTitle('plan', mirror.mirrorResolve(config, 'd:/repo', 'plan'), true)
  assert.match(title, /^Plan：n — q\/n \(max\) · 项目覆盖：/)
  assert.match(mirror.routeTitle('act', mirror.mirrorResolve(pair(), '', 'act'), true), /· 全局配置$/)
})
