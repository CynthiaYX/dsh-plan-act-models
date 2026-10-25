/**
 * Entry-point tests: load the REAL `index.js` and drive its listeners.
 *
 * This file exists because its absence shipped a broken release. A refactor moved
 * the host helpers into `lib/host.mjs` and dropped the `rootOf`/`resumed` call
 * sites in the entry; every test still passed, because nothing imported
 * `index.js` — the suite only exercised `lib/`. Meanwhile the Host could not
 * activate the plugin at all (`fiberPhase: "failed"`).
 *
 * `index.js` used to be untestable because it imports `@deepseek-ai/schemastery`,
 * which only resolves inside a packaged Host. `lib/schema.mjs` honours
 * `DSH_SCHEMASTER_ROOT`, so this file builds a throwaway root in the OS temp
 * directory and loads the entry for real. `node --test` runs each file in its own
 * process, so mutating `process.env` here cannot leak into the other suites.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Build a schemastery stand-in that satisfies `lib/schema.mjs`.
 *
 * The packaged schemastery has no named exports — it is `export { Schema as
 * default }` only — so every helper has to hang off the default export, exactly
 * as the real module does through `createRequire`.
 */
function fakeSchemaRoot() {
  const root = mkdtempSync(join(tmpdir(), 'par-schema-'))
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@deepseek-ai/schemastery',
      version: '3.18.5',
      type: 'module',
      main: 'index.mjs',
      exports: { '.': './index.mjs' },
    }),
  )
  writeFileSync(
    join(pkg, 'index.mjs'),
    [
      'function make() {',
      '  const s = {',
      '    meta: {},',
      '    default(v) { s.meta.default = v; return s },',
      '    volatile() { s.meta.volatile = true; return s },',
      '  }',
      '  return s',
      '}',
      'const z = {',
      '  string: () => make(),',
      '  boolean: () => make(),',
      '  number: () => make(),',
      '  object: () => make(),',
      '  union: () => make(),',
      '  dict: () => make(),',
      '  const: () => make(),',
      '}',
      'z.default = z',
      'export default z',
      '',
    ].join('\n'),
  )
  return root
}

/** `lib/schema.mjs` reads the variable at call time, so set it before importing. */
process.env.DSH_SCHEMASTER_ROOT = fakeSchemaRoot()
const entry = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const EFFORTS = ['max', 'high']

/** A stub `llm` service with one servable provider/model pair. */
function stubLlm(models = [{ id: 'm1' }]) {
  return {
    listProviders: () => [{ id: 'cline-pass' }],
    listModels: async () => models,
    resolveModelInfo: async () => ({ reasoning: { efforts: EFFORTS.map((id) => ({ id })) } }),
  }
}

/**
 * Drive one `apply()` against a fake Host.
 *
 * @param overrides - tweaks for the scenario under test.
 * @returns the fake Host, the recorded listener table, and collected warnings.
 */
function harness(overrides = {}) {
  const listeners = []
  const warnings = []
  const roots = overrides.roots ?? [newAgent('root-1')]
  const events = {}

  const ctx = {
    get: (name) => overrides.services?.[name],
    on: (name, fn) => {
      events[name] = fn
      return () => {}
    },
    inject: () => {},
    effect: (fn) => {
      events.teardown = fn()
    },
    logger: { warn: (message) => warnings.push(message) },
    agents: { roots: () => overrides.rootList ?? roots },
    fiber: {},
  }

  const config = {
    enabled: { get: () => overrides.enabled ?? true },
    plan: { get: () => overrides.plan ?? { provider: 'cline-pass', model: 'm1', reasoningEffort: 'max' } },
    act: { get: () => overrides.act ?? { provider: 'cline-pass', model: 'm1', reasoningEffort: 'high' } },
    projects: { get: () => overrides.projects ?? {} },
  }

  entry.apply(ctx, config)
  return { listeners, warnings, events, ctx, roots }
}

function newAgent(id, { cwd = 'C:/work', origin, requestHeader } = {}) {
  const listeners = []
  return {
    id,
    ctx: {
      on: (name, fn) => {
        listeners.push({ name, fn })
        return () => {
          const at = listeners.findIndex((item) => item.name === name && item.fn === fn)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    },
    session: {
      header: origin === undefined ? { cwd } : { cwd, origin },
      requestHeader: requestHeader ?? (() => undefined),
    },
    listeners,
  }
}

/** Resolve the one listener registered on an Agent for `name`. */
function handlerFor(agent, name) {
  const found = agent.listeners.filter((item) => item.name === name)
  assert.equal(found.length, 1, `expected exactly one ${name} listener, got ${found.length}`)
  return found[0].fn
}

const LISTENERS = ['agent/request', 'system-prompt/assemble', 'agent/pre-step']

/** The services `apply` reads lazily; the mode reader needs one of the two. */
function services({ planActive = false, llm = stubLlm() } = {}) {
  return {
    llm,
    sessionProjections: { stateOf: (_session, key) => (key === 'plan' ? { active: planActive } : undefined) },
    agentPresets: { serviceFor: () => undefined },
  }
}

test('apply activates and registers all three listeners on a pre-existing Agent', () => {
  // Regression guard for the released breakage: `attach` referenced `rootOf` and
  // `resumed` without defining them, so this threw `ReferenceError` and the Host
  // could not publish any Agent — the composer stayed disabled until the plugin
  // was turned off.
  const { roots } = harness({ services: services() })
  assert.deepEqual(
    roots[0].listeners.map((item) => item.name),
    LISTENERS,
  )
})

test('apply survives with no pre-existing Agents', () => {
  const { roots } = harness({ services: services(), roots: [], rootList: [] })
  assert.equal(roots.length, 0)
})

test('a load failure while attaching is reported once and never escapes', () => {
  // `attach` runs inside the Host's uncaught `agent/created` serial, so an
  // escaped throw takes the whole session down. One bad Agent must degrade to a
  // warning instead.
  const broken = newAgent('broken')
  broken.ctx.on = () => {
    throw new Error('listener registration failed')
  }
  const healthy = newAgent('healthy')

  const { warnings, roots } = harness({ services: services(), roots: [], rootList: [broken, healthy] })

  assert.equal(
    warnings.filter((message) => message.includes('无法为该会话挂载路由')).length,
    1,
    'exactly one attachment failure must be reported',
  )
  assert.deepEqual(
    healthy.listeners.map((item) => item.name),
    LISTENERS,
    'a healthy Agent must still be attached after a broken one',
  )
  assert.equal(roots.length, 0)
})

test('a throwing dispose during teardown does not escape', () => {
  const agent = newAgent('a1')
  const { events } = harness({ services: services(), roots: [agent] })
  agent.ctx.on = () => {
    throw new Error('dispose failed')
  }
  assert.doesNotThrow(() => events.teardown())
})

test('agent/created attaches and agent/disposed detaches', () => {
  const { events } = harness({ services: services(), roots: [], rootList: [] })
  const agent = newAgent('late')

  events['agent/created']({ agent })
  assert.deepEqual(agent.listeners.map((item) => item.name), LISTENERS)

  events['agent/disposed']({ agent })
  assert.deepEqual(agent.listeners, [], 'disposal must unsubscribe every listener')
})

test('subagent Agents are never attached', () => {
  const subagent = newAgent('sub', { origin: 'subagent' })
  const { events } = harness({ services: services(), roots: [], rootList: [] })

  events['agent/created']({ agent: subagent })
  assert.deepEqual(subagent.listeners, [])
})

test('a resumed session passes its first request through untouched', () => {
  // Covers the restored `resumed` helper: an Agent that already has a request
  // header must not be re-routed until a real Plan/Act change happens.
  const agent = newAgent('resumed', { requestHeader: () => ({ config: { provider: 'other', model: 'x' } }) })
  const { events } = harness({ services: services({ planActive: false }), roots: [], rootList: [] })

  events['agent/created']({ agent })
  const original = { provider: 'other', model: 'x', reasoningEffort: 'low' }
  const request = handlerFor(agent, 'agent/request')

  return request({}, async () => original).then((result) => {
    assert.deepEqual(result, original)
  })
})

test('a project set to off is left untouched', () => {
  // Covers the restored `rootOf` helper: the override table is keyed by the
  // Agent's normalized workspace root.
  const agent = newAgent('scoped', { cwd: 'C:/work' })
  const { events } = harness({
    services: services({ planActive: true }),
    roots: [],
    rootList: [],
    projects: { 'c:/work': { mode: 'off', plan: {}, act: {} } },
  })

  events['agent/created']({ agent })
  const original = { provider: 'cline-pass', model: 'm1', reasoningEffort: 'high' }

  return handlerFor(agent, 'agent/request')({}, async () => original).then((result) => {
    assert.deepEqual(result, original)
  })
})

test('Plan mode routes to the Plan effort and Act mode to the Act effort', async () => {
  const planAgent = newAgent('plan')
  const plan = harness({ services: services({ planActive: true }), roots: [], rootList: [] })
  plan.events['agent/created']({ agent: planAgent })
  const routed = await handlerFor(planAgent, 'agent/request')(
    {},
    async () => ({ provider: 'p', model: 'm', maxTokens: 1000 }),
  )
  assert.deepEqual(routed, {
    provider: 'cline-pass',
    model: 'm1',
    maxTokens: 1000,
    reasoningEffort: 'max',
  })

  const actAgent = newAgent('act')
  const act = harness({ services: services({ planActive: false }), roots: [], rootList: [] })
  act.events['agent/created']({ agent: actAgent })
  const actRouted = await handlerFor(actAgent, 'agent/request')(
    {},
    async () => ({ provider: 'cline-pass', model: 'm1', maxTokens: 1000, reasoningEffort: 'max' }),
  )
  assert.equal(actRouted.reasoningEffort, 'high')
})

test('the policy helper routes on the committed mode only after the switch', async () => {
  // The state machine itself is covered by routing.test.mjs; this asserts the
  // entry wires a live state per Agent instead of re-deciding from scratch.
  let planActive = false
  const live = services({ planActive: false })
  live.sessionProjections = { stateOf: (_session, key) => (key === 'plan' ? { active: planActive } : undefined) }

  const agent = newAgent('switching')
  const { events } = harness({ services: live, roots: [], rootList: [] })
  events['agent/created']({ agent })
  const request = handlerFor(agent, 'agent/request')
  const seed = async () => ({ provider: 'cline-pass', model: 'm1' })

  assert.equal((await request({}, seed)).reasoningEffort, 'high')

  planActive = true
  assert.equal((await request({}, seed)).reasoningEffort, 'max')

  planActive = false
  assert.equal((await request({}, seed)).reasoningEffort, 'high')
})

test('assembly variables follow the previewed route', async () => {
  const agent = newAgent('asm')
  const { events } = harness({ services: services({ planActive: true }), roots: [], rootList: [] })
  events['agent/created']({ agent })

  const assembled = await handlerFor(agent, 'system-prompt/assemble')(
    {},
    {},
    async () => ({ variables: { provider: 'stale', model: 'stale' } }),
  )
  assert.deepEqual(assembled.variables, { provider: 'cline-pass', model: 'm1' })
})

test('the Host "[model changed]" notice is dropped while routing', async () => {
  const agent = newAgent('notice')
  const { events } = harness({ services: services({ planActive: true }), roots: [], rootList: [] })
  events['agent/created']({ agent })

  const kept = await handlerFor(agent, 'agent/pre-step')(
    {},
    async () => ({
      kind: 'enter',
      messages: [{ source: { kind: 'model-selection' } }, { body: 'real input' }],
    }),
  )
  assert.deepEqual(kept.messages, [{ body: 'real input' }])
})

test('a disabled plugin still attaches but never rewrites the request', async () => {
  const agent = newAgent('off')
  const { events } = harness({ services: services({ planActive: true }), enabled: false, roots: [], rootList: [] })
  events['agent/created']({ agent })

  const original = { provider: 'p', model: 'm' }
  assert.deepEqual(await handlerFor(agent, 'agent/request')({}, async () => original), original)
})
