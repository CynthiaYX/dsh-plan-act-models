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
  formatRoute,
  normalizeRoute,
  projectKey,
  resolveTarget,
  sameRoute,
  sameSelection,
  sameTrack,
  sessionTrack,
  switchActOnApproval,
  switchPlan,
  unref,
} from '../lib/routing.mjs'

const PLAN_ROUTE = { provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }
const ACT_ROUTE = { provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }

function config(overrides = {}) {
  return { enabled: true, plan: PLAN_ROUTE, act: ACT_ROUTE, projects: {}, ...overrides }
}

/** A plan entry, for the two switch helpers. */
function plan(current = ACT_ROUTE, overrides = {}) {
  return {
    enabled: true,
    config: config(overrides),
    path: '/w',
    current,
    mode: MODE_PLAN,
  }
}

/** An approval entry, for the two switch helpers. */
function approval(current = PLAN_ROUTE, overrides = {}) {
  return { enabled: true, config: config(overrides), path: '/w', current }
}

// --- primitives ------------------------------------------------------------

test('unref unwraps volatile cells, getters and plain values', () => {
  assert.equal(unref(3), 3)
  assert.equal(unref(null), null)
  assert.deepEqual(unref({ get: () => ({ a: 1 }) }), { a: 1 })
  assert.deepEqual(unref(() => ({ a: 2 })), { a: 2 })
  assert.deepEqual(unref({ value: { a: 3 } }), { a: 3 })
  assert.equal(unref({ get: () => { throw new Error('gone') } }), undefined)
})

test('normalizeRoute trims, drops an empty effort and rejects half a route', () => {
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ', reasoningEffort: ' ' }), {
    provider: 'p',
    model: 'm',
  })
  assert.equal(normalizeRoute({ provider: 'p' }), null)
  assert.equal(normalizeRoute({ model: 'm' }), null)
  assert.equal(normalizeRoute(null), null)
  const plan = PLAN_ROUTE
  assert.equal(normalizeRoute({ provider: plan.provider, model: plan.model, reasoningEffort: 'max' }).reasoningEffort, 'max')
})

test('sameRoute ignores the effort, sameSelection does not', () => {
  assert.equal(sameRoute(PLAN_ROUTE, ACT_ROUTE), true)
  assert.equal(sameSelection(PLAN_ROUTE, ACT_ROUTE), false)
  assert.equal(sameSelection(PLAN_ROUTE, { ...PLAN_ROUTE }), true)
  assert.equal(sameSelection(PLAN_ROUTE, { provider: 'x', model: 'y' }), false)
})

test('formatRoute names the effort only when one is pinned', () => {
  assert.equal(formatRoute(PLAN_ROUTE), 'cline-pass/deepseek-v4.1-flash (max)')
  assert.equal(formatRoute({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(formatRoute(null), 'none')
})

test('projectKey normalizes separators, trailing slashes and case', () => {
  assert.equal(projectKey('D:\\work\\repo\\'), 'd:/work/repo')
  assert.equal(projectKey('/home/me/repo//'), '/home/me/repo')
  assert.equal(projectKey('  '), '')
  assert.equal(projectKey(undefined), '')
})

// --- resolveTarget ---------------------------------------------------------

test('resolveTarget reads the global pair when no project matches', () => {
  const global = resolveTarget(config(), '/elsewhere', MODE_PLAN)
  assert.equal(global.kind, 'route')
  assert.equal(global.scope, 'global')
  assert.equal(global.projectKey, null)
  assert.deepEqual(global.route, PLAN_ROUTE)

  const act = resolveTarget(config(), '/elsewhere', MODE_ACT)
  assert.deepEqual(act.route, ACT_ROUTE)
})

test('resolveTarget applies a matching project override verbatim', () => {
  const projects = {
    'D:\\work\\repo': {
      mode: 'override',
      plan: { provider: 'local', model: 'planner', reasoningEffort: 'low' },
      act: { provider: 'local', model: 'builder' },
    },
  }
  const plan = resolveTarget(config({ projects }), 'd:/work/repo/', MODE_PLAN)
  assert.equal(plan.kind, 'route')
  assert.equal(plan.scope, 'project')
  assert.equal(plan.projectKey, 'D:\\work\\repo')
  assert.deepEqual(plan.route, { provider: 'local', model: 'planner', reasoningEffort: 'low' })

  const act = resolveTarget(config({ projects }), 'd:/WORK/repo', MODE_ACT)
  assert.deepEqual(act.route, { provider: 'local', model: 'builder' })
})

test('resolveTarget reports a project set to off', () => {
  const projects = { '/w': { mode: 'off', plan: PLAN_ROUTE, act: ACT_ROUTE } }
  const target = resolveTarget(config({ projects }), '/w', MODE_PLAN)
  assert.equal(target.kind, 'off')
  assert.equal(target.scope, 'project')
})

test('resolveTarget reports an incomplete route without inventing one', () => {
  const broken = resolveTarget(config({ plan: { provider: 'p', model: '' } }), '/w', MODE_PLAN)
  assert.equal(broken.kind, 'invalid')
  assert.match(broken.reason, /全局 plan 路由缺少 provider 或 model/)

  const overrideBroken = resolveTarget(
    config({ projects: { '/w': { mode: 'override', plan: { provider: '', model: '' } } } }),
    '/w',
    MODE_PLAN,
  )
  assert.equal(overrideBroken.kind, 'invalid')
  assert.match(overrideBroken.reason, /项目覆盖「\/w」的 plan 路由缺少 provider 或 model/)
})

test('resolveTarget ignores a project entry in inherit mode', () => {
  const projects = { '/w': { mode: 'inherit', plan: { provider: 'local', model: 'nope' } } }
  const target = resolveTarget(config({ projects }), '/w', MODE_PLAN)
  assert.equal(target.scope, 'global')
  assert.deepEqual(target.route, PLAN_ROUTE)
})

// --- sameTrack / sessionTrack ---------------------------------------------

test('sameTrack requires provider and model, but accepts any effort when none is pinned', () => {
  assert.equal(sameTrack(ACT_ROUTE, { provider: 'cline-pass', model: 'deepseek-v4.1-flash' }), true)
  // A pinned effort is compared: `high` is not the Plan route's `max`.
  assert.equal(sameTrack(ACT_ROUTE, PLAN_ROUTE), false)
  assert.equal(sameTrack({ provider: 'cline-pass', model: 'deepseek-v4.1-flash' }, ACT_ROUTE), false)
  assert.equal(sameTrack({ provider: 'other', model: 'deepseek-v4.1-flash' }, ACT_ROUTE), false)
  assert.equal(sameTrack(null, ACT_ROUTE), false)
})

test('sessionTrack names the track the selection sits on', () => {
  assert.equal(sessionTrack(PLAN_ROUTE, config(), '/w', MODE_ACT), MODE_PLAN)
  assert.equal(sessionTrack(ACT_ROUTE, config(), '/w', MODE_PLAN), MODE_ACT)
  assert.equal(sessionTrack({ provider: 'x', model: 'y' }, config(), '/w', MODE_PLAN), null)
  assert.equal(sessionTrack(null, config(), '/w', MODE_PLAN), null)
})

test('sessionTrack uses the committed mode only to break a tie', () => {
  // Same provider+model and no pinned effort on either side: the selection
  // cannot tell the tracks apart, so the committed mode decides.
  const same = { provider: 'cline-pass', model: 'deepseek-v4.1-flash' }
  const both = config({ plan: same, act: same })
  assert.equal(sessionTrack(ACT_ROUTE, both, '/w', MODE_PLAN), MODE_PLAN)
  assert.equal(sessionTrack(ACT_ROUTE, both, '/w', MODE_ACT), MODE_ACT)
})

test('sessionTrack resolves through a project override', () => {
  const projects = {
    '/w': { mode: 'override', plan: { provider: 'local', model: 'planner' }, act: ACT_ROUTE },
  }
  const cfg = config({ projects })
  assert.equal(sessionTrack({ provider: 'local', model: 'planner' }, cfg, '/w', MODE_ACT), MODE_PLAN)
  assert.equal(sessionTrack(PLAN_ROUTE, cfg, '/w', MODE_ACT), null)
})

// --- switchPlan ------------------------------------------------------------

test('switchPlan selects the Plan route when leaving Act behind', () => {
  const verdict = switchPlan(plan(ACT_ROUTE))
  assert.equal(verdict.action, 'select')
  assert.equal(verdict.track, MODE_PLAN)
  assert.deepEqual(verdict.route, PLAN_ROUTE)
  assert.equal(verdict.scope, 'global')
})

test('switchPlan is a no-op when the selection is already on the Plan track', () => {
  assert.deepEqual(switchPlan(plan(PLAN_ROUTE)), { action: 'pass', reason: 'on-track' })
})

test('switchPlan keeps a hand-picked plan effort the configuration leaves open', () => {
  // The user picked plan at `low`; the configured route pins no effort, so both
  // are the Plan track and re-selecting would overwrite their choice.
  const cfg = { plan: { provider: 'cline-pass', model: 'deepseek-v4.1-flash' } }
  assert.deepEqual(switchPlan(plan({ provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }, cfg)), {
    action: 'pass',
    reason: 'on-track',
  })
})

test('switchPlan still corrects a hand-picked effort when one is pinned', () => {
  const verdict = switchPlan(plan({ provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' }))
  assert.equal(verdict.action, 'select')
  assert.equal(verdict.route.reasoningEffort, 'max')
})

test('switchPlan steps aside for the total switch, a dead project and a broken route', () => {
  assert.deepEqual(switchPlan({ ...plan(), enabled: false }), { action: 'pass', reason: 'disabled' })
  assert.deepEqual(
    switchPlan(plan(ACT_ROUTE, { projects: { '/w': { mode: 'off' } } })),
    { action: 'pass', reason: 'project-off' },
  )
  assert.deepEqual(
    switchPlan(plan(ACT_ROUTE, { plan: { provider: '', model: '' } })),
    { action: 'pass', reason: 'route-incomplete' },
  )
})

test('switchPlan works with no committed selection at all', () => {
  const verdict = switchPlan(plan(null))
  assert.equal(verdict.action, 'select')
  assert.deepEqual(verdict.route, PLAN_ROUTE)
})

// --- switchActOnApproval ---------------------------------------------------

test('switchActOnApproval forces Act even though the selection is already Act', () => {
  // The rule intentionally ignores the current track; here the selection only
  // differs by effort, which is exactly the case a plain "already Act" check
  // would get wrong.
  const verdict = switchActOnApproval(approval({ provider: 'cline-pass', model: 'deepseek-v4.1-flash' }))
  assert.equal(verdict.action, 'select')
  assert.equal(verdict.route.reasoningEffort, 'high')
})

test('switchActOnApproval selects Act from a Plan selection', () => {
  const verdict = switchActOnApproval(approval(PLAN_ROUTE))
  assert.equal(verdict.action, 'select')
  assert.equal(verdict.track, MODE_ACT)
  assert.deepEqual(verdict.route, ACT_ROUTE)
})

test('switchActOnApproval skips an identical committed selection', () => {
  assert.deepEqual(switchActOnApproval(approval(ACT_ROUTE)), { action: 'pass', reason: 'already-selected' })
})

test('switchActOnApproval follows the same three stand-aside conditions', () => {
  assert.deepEqual(switchActOnApproval({ ...approval(), enabled: false }), { action: 'pass', reason: 'disabled' })
  assert.deepEqual(switchActOnApproval(approval(PLAN_ROUTE, { projects: { '/w': { mode: 'off' } } })), {
    action: 'pass',
    reason: 'project-off',
  })
  assert.deepEqual(switchActOnApproval(approval(PLAN_ROUTE, { act: { provider: 'p', model: '' } })), {
    action: 'pass',
    reason: 'route-incomplete',
  })
})

test('switchActOnApproval uses the project override for the act route', () => {
  const projects = { '/w': { mode: 'override', plan: PLAN_ROUTE, act: { provider: 'local', model: 'builder' } } }
  const verdict = switchActOnApproval(approval(PLAN_ROUTE, { projects }))
  assert.equal(verdict.action, 'select')
  assert.equal(verdict.scope, 'project')
  assert.deepEqual(verdict.route, { provider: 'local', model: 'builder' })
})

test('both switches agree on an empty route config', () => {
  const empty = { enabled: true, plan: {}, act: {}, projects: {} }
  assert.deepEqual(switchPlan({ ...plan(null), config: empty }), {
    action: 'pass',
    reason: 'route-incomplete',
  })
  assert.deepEqual(switchActOnApproval({ ...approval(null), config: empty }), {
    action: 'pass',
    reason: 'route-incomplete',
  })
})
