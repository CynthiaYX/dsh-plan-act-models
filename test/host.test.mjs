/**
 * Tests for `lib/host.mjs`: the plan-mode lookup and the provider catalog.
 *
 * These exercise the real helpers `index.js` wires up. `index.js` itself cannot
 * be imported here because it resolves schemastery from a packaged Host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCatalog, createModeReader } from '../lib/host.mjs'

const AGENT = { ctx: {}, session: { header: { cwd: '/w' } } }

function reader(services) {
  const warnings = []
  const modeOf = createModeReader({
    agentPresets: () => services.agentPresets,
    projections: () => services.sessionProjections,
    warn: (message) => warnings.push(message),
  })
  return { modeOf, warnings }
}

test('plan mode is read through the per-agent preset lookup', () => {
  const { modeOf, warnings } = reader({
    agentPresets: {
      serviceFor: (_agent, name) => (name === 'planMode' ? { get: () => ({ active: true }) } : undefined),
    },
  })
  assert.equal(modeOf(AGENT), 'plan')
  assert.deepEqual(warnings, [])
})

test('the root-plane planMode service is NOT reachable, so the projection decides', () => {
  // This is the original bug: `ctx.get('planMode')` is a different realm symbol,
  // so a Host exposing it only at the root plane leaves `serviceFor` empty.
  const { modeOf } = reader({
    planMode: { get: () => ({ active: true }) },
    sessionProjections: { stateOf: (_session, key) => (key === 'plan' ? { active: true } : undefined) },
  })
  assert.equal(modeOf(AGENT), 'plan')
})

test('the projection fallback works when no preset registry is present', () => {
  const { modeOf } = reader({
    sessionProjections: { stateOf: (_session, key) => (key === 'plan' ? { active: false } : undefined) },
  })
  assert.equal(modeOf(AGENT), 'act')
})

test('act mode from the preset controller', () => {
  const { modeOf } = reader({
    agentPresets: { serviceFor: () => ({ get: () => ({ active: false, pending: false }) }) },
  })
  assert.equal(modeOf(AGENT), 'act')
})

test('a missing plan source warns once instead of silently routing Act', () => {
  const { modeOf, warnings } = reader({})
  assert.equal(modeOf(AGENT), 'act')
  assert.equal(modeOf(AGENT), 'act')
  assert.equal(warnings.length, 1, 'the degradation must be reported exactly once')
  assert.match(warnings[0], /Act/)
})

test('a throwing plan source degrades instead of failing the request', () => {
  const { modeOf, warnings } = reader({
    sessionProjections: {
      stateOf: () => {
        throw new Error('plan-mode requires the plan session projection')
      },
    },
  })
  assert.equal(modeOf(AGENT), 'act')
  assert.equal(warnings.length, 1)
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
  await assert.rejects(() => assertServable({ provider: 'nope', model: 'm' }), /当前不可用/)
})

test('a missing llm service fails closed as documented', async () => {
  const { assertServable } = catalogOf(undefined)
  await assert.rejects(
    () => assertServable({ provider: 'p', model: 'm' }),
    /宿主没有提供 llm 服务/,
  )
})
