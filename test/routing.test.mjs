/**
 * Decision-table tests for `lib/routing.mjs`.
 *
 * The policy module has no Host dependency, so the whole router is exercised
 * here against plain values.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODE_ACT,
  MODE_PLAN,
  createState,
  decide,
  normalizeRoute,
  previewRoute,
  projectKey,
  resolveTarget,
  sameSelection,
  withRoute,
} from '../lib/routing.mjs'

const PLAN_ROUTE = { provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }
const ACT_ROUTE = { provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }

function config(overrides = {}) {
  return { enabled: true, plan: PLAN_ROUTE, act: ACT_ROUTE, projects: {}, ...overrides }
}

/** Run one decision for `mode`, with the Host having resolved `resolved`. */
function step(state, { mode = MODE_ACT, resolved = null, enabled = true, path = '/w', projects = {} } = {}) {
  const target = resolveTarget(config({ projects }), path, mode)
  return decide(state, { enabled, mode, resolved, target })
}

test('a fresh Act session routes to the Act route', () => {
  const state = createState({ mode: MODE_ACT, resumed: false })
  const verdict = step(state)
  assert.equal(verdict.action, 'route')
  assert.deepEqual(verdict.route, ACT_ROUTE)
})

test('a fresh Plan session routes to the Plan route', () => {
  const state = createState({ mode: MODE_PLAN, resumed: false })
  const verdict = step(state, { mode: MODE_PLAN })
  assert.equal(verdict.action, 'route')
  assert.deepEqual(verdict.route, PLAN_ROUTE)
})

test('a resumed session passes through until a real Plan/Act change', () => {
  const state = createState({ mode: MODE_ACT, resumed: true })
  assert.equal(step(state, { resolved: ACT_ROUTE }).action, 'pass')
  // The committed transition clears the bypass.
  assert.equal(step(state, { mode: MODE_PLAN, resolved: ACT_ROUTE }).action, 'route')
})

test('re-enabling resumes routing in the same mode instead of staying bypassed', () => {
  const state = createState({ mode: MODE_ACT, resumed: false })
  assert.equal(step(state).action, 'route')

  // Switched off: pass through.
  assert.equal(step(state, { enabled: false }).action, 'pass')

  // Switched back on in the SAME mode: must route again. This is the case the
  // old `bypass = true` on disable left stuck forever.
  const verdict = step(state, { resolved: ACT_ROUTE })
  assert.equal(verdict.action, 'route')
  assert.deepEqual(verdict.route, ACT_ROUTE)
})

test('picking only a different reasoning effort counts as a manual override', () => {
  const state = createState({ mode: MODE_PLAN, resumed: false })
  // Step 1: the plugin forces the Plan route.
  assert.deepEqual(step(state, { mode: MODE_PLAN }).route, PLAN_ROUTE)
  // Step 2: the loop echoes the forced route back; not a manual pick.
  assert.equal(step(state, { mode: MODE_PLAN, resolved: PLAN_ROUTE }).action, 'route')
  // Step 3: the user picks the same provider+model with a different effort.
  const picked = { ...PLAN_ROUTE, reasoningEffort: 'high' }
  const verdict = step(state, { mode: MODE_PLAN, resolved: picked })
  assert.equal(verdict.action, 'pass', 'effort-only pick must be honoured as an override')
  assert.equal(verdict.reason, 'override')
})

test('the echo of a forced route is not mistaken for a manual override', () => {
  const state = createState({ mode: MODE_ACT, resumed: false })
  assert.deepEqual(step(state).route, ACT_ROUTE)
  // Second step seeds from the logged header, so it echoes our own route.
  const verdict = step(state, { resolved: ACT_ROUTE })
  assert.equal(verdict.action, 'route')
  assert.deepEqual(verdict.route, ACT_ROUTE)
})

test('a project can override, disable, or inherit the global pair', () => {
  const path = 'C:/work/demo'
  const key = projectKey(path)

  const override = {
    [key]: { mode: 'override', plan: { provider: 'p', model: 'plan-m' }, act: { provider: 'p', model: 'act-m' } },
  }
  assert.deepEqual(
    resolveTarget(config({ projects: override }), path, MODE_PLAN),
    { kind: 'route', route: { provider: 'p', model: 'plan-m' }, scope: 'project', projectKey: key },
  )

  const off = { [key]: { mode: 'off', plan: PLAN_ROUTE, act: ACT_ROUTE } }
  assert.equal(resolveTarget(config({ projects: off }), path, MODE_ACT).kind, 'off')

  const inherit = { [key]: { mode: 'inherit', plan: { provider: 'p', model: 'x' } } }
  const inherited = resolveTarget(config({ projects: inherit }), path, MODE_ACT)
  assert.equal(inherited.scope, 'global')
  assert.deepEqual(inherited.route, ACT_ROUTE)
})

test('an incomplete override blocks that project only', () => {
  const path = 'C:/work/demo'
  const key = projectKey(path)
  const projects = { [key]: { mode: 'override', plan: { provider: 'p', model: 'm' }, act: { provider: '', model: '' } } }
  const state = createState({ mode: MODE_ACT, resumed: false })

  const blocked = step(state, { path, projects })
  assert.equal(blocked.action, 'block')
  assert.match(blocked.message, /项目覆盖/)

  // A different project keeps working.
  assert.equal(step(createState({ mode: MODE_ACT, resumed: false }), { path: 'C:/other' }).action, 'route')
})

test('an incomplete global route blocks instead of silently falling back', () => {
  const target = resolveTarget(config({ act: { provider: 'p', model: '' } }), '/w', MODE_ACT)
  assert.equal(target.kind, 'invalid')
  const verdict = decide(createState({ mode: MODE_ACT, resumed: false }), {
    enabled: true, mode: MODE_ACT, resolved: null, target,
  })
  assert.equal(verdict.action, 'block')
})

test('project keys compare case- and separator-insensitively', () => {
  assert.equal(projectKey('C:\\Work\\Demo\\'), projectKey('c:/work/demo'))
  const projects = { 'C:/Work/Demo': { mode: 'off' } }
  assert.equal(resolveTarget(config({ projects }), 'c:\\work\\demo', MODE_ACT).kind, 'off')
})

test('previewRoute hides the route while bypassed', () => {
  const state = createState({ mode: MODE_ACT, resumed: true })
  const target = resolveTarget(config(), '/w', MODE_ACT)
  assert.equal(previewRoute(state, target), null)
  state.bypass = false
  assert.deepEqual(previewRoute(state, target), ACT_ROUTE)
})

test('withRoute replaces the route but keeps unrelated request controls', () => {
  const resolved = { provider: 'old', model: 'old-m', reasoningEffort: 'low', maxTokens: 1234, temperature: 0.2 }
  assert.deepEqual(withRoute(resolved, ACT_ROUTE), {
    provider: ACT_ROUTE.provider,
    model: ACT_ROUTE.model,
    reasoningEffort: 'high',
    maxTokens: 1234,
    temperature: 0.2,
  })
})

test('withRoute drops an inherited effort when the route has none', () => {
  const merged = withRoute({ provider: 'old', model: 'm', reasoningEffort: 'low' }, { provider: 'p', model: 'm' })
  assert.equal('reasoningEffort' in merged, false)
})

test('sameSelection distinguishes effort, sameRoute does not', () => {
  const a = { provider: 'p', model: 'm', reasoningEffort: 'max' }
  const b = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  assert.equal(sameSelection(a, b), false)
  assert.equal(sameSelection(a, { ...a }), true)
})

test('normalizeRoute tolerates the volatile-cell shapes the Loader hands over', () => {
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ', reasoningEffort: '  ' }), { provider: 'p', model: 'm' })
  assert.deepEqual(
    normalizeRoute({ get: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }) }),
    { provider: 'p', model: 'm', reasoningEffort: 'max' },
  )
  assert.equal(normalizeRoute({ provider: '', model: 'm' }), null)
  assert.equal(normalizeRoute(null), null)
})
