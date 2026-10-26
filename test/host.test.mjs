/**
 * Tests for `lib/host.mjs`: the provider catalog, the committed-selection reader
 * and the switcher.
 *
 * These exercise the real helpers `index.js` wires up. `index.js` itself cannot
 * be imported here because it resolves schemastery from a packaged Host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { committedSelection, createCatalog, createSwitcher, trackWord } from '../lib/host.mjs'

const AGENT = { id: 'sess-1', ctx: {}, session: { header: { cwd: '/w' } } }
const ACT_ROUTE = { provider: 'cline-pass', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }

// --- committedSelection ----------------------------------------------------

/** A `sessionProjections` stand-in reporting one `modelSelection` state. */
function projectionsOf(state) {
  return { stateOf: (_session, key) => (key === 'modelSelection' ? state : undefined) }
}

test('committedSelection prefers the pending selection over the last one', () => {
  const state = { pending: ACT_ROUTE, lastUsed: { provider: 'x', model: 'y' } }
  assert.deepEqual(committedSelection(() => projectionsOf(state), AGENT.session), ACT_ROUTE)
})

test('committedSelection falls back to lastUsed when nothing is pending', () => {
  const lastUsed = { provider: 'x', model: 'y' }
  assert.deepEqual(committedSelection(() => projectionsOf({ pending: null, lastUsed }), AGENT.session), lastUsed)
})

test('committedSelection reports nothing for a cold session', () => {
  assert.equal(committedSelection(() => projectionsOf({ pending: null, lastUsed: null }), AGENT.session), null)
  assert.equal(committedSelection(() => undefined, AGENT.session), null)
  assert.equal(committedSelection(() => ({ stateOf: () => { throw new Error('gone') } }), AGENT.session), null)
})

test('trackWord names the two mode ids', () => {
  assert.equal(trackWord('plan'), 'Plan')
  assert.equal(trackWord('act'), 'Act')
})

// --- createSwitcher --------------------------------------------------------

/**
 * A switcher wired to fakes.
 * @param options.controller - the `sessionController` service, or undefined.
 * @param options.state - the `modelSelection` projection state.
 * @param options.servable - thrown error for `assertServable`, if any.
 */
function switcherOf({ controller, state = null, servable = null } = {}) {
  const warnings = []
  const calls = []
  const service = controller === undefined || controller === null
    ? undefined
    : {
        selectModel: async (request) => {
          calls.push(request)
          if (typeof controller === 'function') return controller(request)
          return { selected: request }
        },
        ...controller,
      }
  const select = createSwitcher({
    sessionController: () => service,
    projections: () => (state === null ? undefined : projectionsOf(state)),
    assertServable: async () => {
      if (servable !== null) throw servable
    },
    warn: (message) => warnings.push(message),
  })
  return { select, warnings, calls }
}

test('the switcher commits an unselected route through selectModel', async () => {
  const { select, calls, warnings } = switcherOf({ controller: {} })
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), true)
  assert.deepEqual(calls, [{
    sessionId: 'sess-1',
    provider: 'cline-pass',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  }])
  assert.deepEqual(warnings, [])
})

test('the switcher omits reasoningEffort when the route does not pin one', async () => {
  const { select, calls } = switcherOf({ controller: {} })
  await select(AGENT, { provider: 'p', model: 'm' }, 'sess-1')
  assert.equal('reasoningEffort' in calls[0], false)
})

test('the switcher skips a selection the session already committed', async () => {
  const { select, calls, warnings } = switcherOf({
    controller: {},
    state: { pending: null, lastUsed: { ...ACT_ROUTE } },
  })
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(warnings, [])
})

test('the switcher still commits when only the effort differs', async () => {
  const { select, calls } = switcherOf({
    controller: {},
    state: { pending: null, lastUsed: { provider: ACT_ROUTE.provider, model: ACT_ROUTE.model } },
  })
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), true)
  assert.equal(calls.length, 1)
})

test('an unservable route is reported once and never reaches selectModel', async () => {
  const { select, calls, warnings } = switcherOf({
    controller: {},
    servable: new Error('provider「p」下没有模型「m」'),
  })
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), false)
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), false)
  assert.deepEqual(calls, [])
  assert.equal(warnings.length, 1, 'the catalog degradation is reported exactly once')
  assert.match(warnings[0], /不切换/)
})

test('a rejecting selectModel is contained and reported once', async () => {
  const { select, warnings } = switcherOf({
    controller: () => {
      throw Object.assign(new Error('session/model-unavailable'), { code: 'session/model-unavailable' })
    },
  })
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), false)
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /切换模型失败/)
  assert.match(warnings[0], /model-unavailable/)
})

test('a missing sessionController degrades with a pointer to the native selector', async () => {
  const { select, warnings } = switcherOf({ controller: null })
  assert.equal(await select(AGENT, ACT_ROUTE, 'sess-1'), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sessionController/)
  assert.match(warnings[0], /原生模型选择器/)
})

function catalogOf(llm, ttlMs) {
  return createCatalog({ llm: () => llm, ttlMs })
}

const EFFORTS = { efforts: [{ id: 'max', name: 'max' }, { id: 'high', name: 'high' }] }

test('one failing provider does not poison the others', async () => {
  const llm = {
    listProviders: () => [{ id: 'good' }, { id: 'bad' }, { id: 'good2' }],
    listModels: async (id) => {
      if (id === 'bad') throw new Error('boom')
      return [{ id: `${id}-m` }]
    },
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { refresh } = catalogOf(llm)
  const snapshot = await refresh()

  assert.deepEqual([...snapshot.providers.keys()], ['good', 'good2'])
  assert.equal(snapshot.failed.get('bad'), 'boom')
  assert.equal(snapshot.error, null, 'a per-provider failure is not a catalog-wide error')
  assert.equal(snapshot.providers.get('good').get('good-m').efforts.length, 2)
})

test('a failing provider is reported by name, not as a global catalog error', async () => {
  const llm = {
    listProviders: () => [{ id: 'ok' }, { id: 'nokey' }],
    listModels: async (id) => {
      if (id === 'nokey') throw new Error('Missing credential')
      return [{ id: 'm' }]
    },
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { assertServable } = catalogOf(llm)
  // A healthy provider still serves.
  await assert.doesNotReject(() => assertServable({ provider: 'ok', model: 'm', reasoningEffort: 'max' }))
  // The broken one explains itself.
  await assert.rejects(
    () => assertServable({ provider: 'nokey', model: 'm' }),
    /枚举 provider「nokey」的模型失败：Missing credential/,
  )
})

test('a sweep with a failing provider is still cached, so a broken provider does not cost a sweep per request', async () => {
  let calls = 0
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => {
      calls += 1
      throw new Error('transient')
    },
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { refresh } = catalogOf(llm, 15_000)
  await refresh()
  await refresh()
  // Per-provider failures are recorded, not retried eagerly: the TTL bounds the
  // staleness, and a broken provider must not add a sweep to every request.
  assert.equal(calls, 1)

  // A zero TTL always re-sweeps, which proves the cached value was the only
  // reason the second call above was free.
  const { refresh: alwaysRefresh } = catalogOf(llm, 0)
  await alwaysRefresh()
  assert.equal(calls, 2)
})

test('a sweep that cannot even list providers is not cached as a success', async () => {
  let calls = 0
  const llm = {
    listProviders: () => {
      calls += 1
      throw new Error('registry exploded')
    },
    listModels: async () => [],
    resolveModelInfo: async () => ({ reasoning: undefined }),
  }
  const { refresh } = catalogOf(llm, 15_000)
  const first = await refresh()
  assert.equal(first.error, 'registry exploded')
  await refresh()
  assert.equal(calls, 2, 'a registry-level failure must be retried, not cached for the whole TTL')
})

test('a successful sweep is cached for the TTL', async () => {
  let calls = 0
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => {
      calls += 1
      return [{ id: 'm' }]
    },
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { refresh } = catalogOf(llm, 15_000)
  await refresh()
  await refresh()
  assert.equal(calls, 1)
})

test('concurrent callers share one in-flight sweep', async () => {
  let calls = 0
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [{ id: 'm' }]
    },
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { refresh } = catalogOf(llm, 15_000)
  await Promise.all([refresh(), refresh(), refresh()])
  assert.equal(calls, 1)
})

test('a provider whose credentials are missing surfaces as an empty model list', async () => {
  // pi-ai returns [] on MISSING_CREDENTIAL rather than throwing.
  const llm = {
    listProviders: () => [{ id: 'nokey' }],
    listModels: async () => [],
    resolveModelInfo: async () => ({ reasoning: undefined }),
  }
  const { refresh } = catalogOf(llm)
  const snapshot = await refresh()
  assert.equal(snapshot.providers.get('nokey').size, 0)
  assert.equal(snapshot.failed.has('nokey'), false)
})

test('an unsupported reasoning effort is rejected with the available ones', async () => {
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { assertServable } = catalogOf(llm)
  await assert.rejects(
    () => assertServable({ provider: 'p', model: 'm', reasoningEffort: 'low' }),
    /不支持思考等级「low」（可选：max \/ high）/,
  )
  await assert.doesNotReject(() => assertServable({ provider: 'p', model: 'm', reasoningEffort: 'high' }))
})

test('an unknown model and an unknown provider get distinct messages', async () => {
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => ({ reasoning: EFFORTS }),
  }
  const { assertServable } = catalogOf(llm)
  await assert.rejects(() => assertServable({ provider: 'p', model: 'other' }), /下没有模型「other」/)
  await assert.rejects(() => assertServable({ provider: 'nope', model: 'm' }), /provider「nope」不可用/)
})

test('a missing llm service lets the switch through to the Host validator', async () => {
  // The catalog is an early, friendlier check, not the authority: without it the
  // switcher still calls `selectModel`, which re-validates and reports its own
  // error. Blocking here would make the dropdown useless in a profile that only
  // hides `llm` from this plugin.
  const { assertServable } = catalogOf(undefined)
  await assert.doesNotReject(() => assertServable({ provider: 'p', model: 'm' }))
})
