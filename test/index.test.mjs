/**
 * Entry-point tests: load the REAL `index.js` and drive its listeners.
 *
 * This file exists because its absence shipped a broken release. A refactor moved
 * the host helpers into `lib/host.mjs` and dropped a call site in the entry; every
 * test still passed, because nothing imported `index.js` — the suite only
 * exercised `lib/`. Meanwhile the Host could not activate the plugin at all
 * (`fiberPhase: "failed"`).
 *
 * `index.js` used to be untestable because it imports `@deepseek-ai/schemastery`,
 * which only resolves inside a packaged Host. `lib/schema.mjs` honours
 * `DSH_SCHEMASTER_ROOT`, so this file builds a throwaway root in the OS temp
 * directory and loads the entry for real. `node --test` runs each file in its own
 * process, so mutating `process.env` here cannot leak into the other suites.
 *
 * The entry no longer rewrites requests: it reacts to two events and calls the
 * Host's own `selectModel`. So these tests assert *when* a switch is attempted
 * and *what* payload it carries, never what a request resolves to.
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
const PLAN_ROUTE = { provider: 'cline-pass', model: 'm1', reasoningEffort: 'max' }
const ACT_ROUTE = { provider: 'cline-pass', model: 'm1', reasoningEffort: 'high' }

/** A stub `llm` service with one servable provider/model pair. */
function stubLlm(models = [{ id: 'm1' }]) {
  return {
    listProviders: () => [{ id: 'cline-pass' }],
    listModels: async () => models,
    resolveModelInfo: async () => ({ reasoning: { efforts: EFFORTS.map((id) => ({ id })) } }),
  }
}

function newAgent(id, { cwd = 'C:/work', origin } = {}) {
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
      id,
      header: origin === undefined ? { cwd } : { cwd, origin },
    },
    listeners,
  }
}

/**
 * Drive one `apply()` against a fake Host.
 *
 * @param overrides - tweaks for the scenario under test.
 * @returns the fake Host, the root listener table, and everything recorded.
 */
function harness(overrides = {}) {
  const warnings = []
  const calls = []
  const roots = overrides.roots ?? [newAgent('root-1')]
  const events = {}
  const agents = new Map((overrides.rootList ?? roots).map((agent) => [agent.id, agent]))

  function selectModelService() {
    return {
      selectModel: async (request) => {
        calls.push(request)
        return { selected: request }
      },
    }
  }

  const services = {
    llm: stubLlm(),
    ...overrides.services,
  }
  // `modelSelection` is what the switcher reads to skip no-op switches. The
  // projection state is `{ lastUsed, pending }`, not a bare route.
  if (services.sessionProjections === undefined) {
    const committed = overrides.selection ?? null
    services.sessionProjections = {
      stateOf: (_session, key) =>
        key === 'modelSelection' && committed !== null
          ? { pending: committed, lastUsed: null }
          : undefined,
    }
  }
  if (!('sessionController' in overrides)) services.sessionController = selectModelService()
  else if (overrides.sessionController !== null) services.sessionController = overrides.sessionController

  const ctx = {
    get: (name) => services[name],
    on: (name, fn) => {
      events[name] = fn
      return () => {}
    },
    inject: () => {},
    effect: (fn) => {
      events.teardown = fn()
    },
    logger: { warn: (message) => warnings.push(message) },
    agents: {
      roots: () => overrides.rootList ?? roots,
      get: (id) => agents.get(id),
    },
    fiber: {},
  }

  const config = {
    enabled: { get: () => overrides.enabled ?? true },
    plan: { get: () => overrides.plan ?? PLAN_ROUTE },
    act: { get: () => overrides.act ?? ACT_ROUTE },
    modes: { get: () => overrides.modes ?? {} },
    projects: { get: () => overrides.projects ?? {} },
  }

  // `select` is async; every assertion below drains the microtask queue first.
  entry.apply(ctx, config)
  return { warnings, calls, events, ctx, roots, agents, services }
}

/** Resolve the one listener registered on an Agent for `name`. */
function handlerFor(agent, name) {
  const found = agent.listeners.filter((item) => item.name === name)
  assert.equal(found.length, 1, `expected exactly one ${name} listener, got ${found.length}`)
  return found[0].fn
}

/** Let the switcher's promise chain settle. */
async function settle(times = 4) {
  // The switcher awaits the catalog sweep, which itself awaits `listModels` and
  // `resolveModelInfo` per model, so plain microtask ticks are not enough.
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** A `tools/result` payload for `exit_plan_mode` returning `value`. */
function approvalEvent(agent, value, { name = 'exit_plan_mode', isError = false } = {}) {
  handlerFor(agent, 'tools/result')({ name, agent }, { isError, value })
}

/** The `plan/mode` event a session commits when plan mode flips. */
function planMode(session, active) {
  return { type: 'plan/mode', data: { active } }
}

test('apply attaches exactly one tools/result listener per Agent', () => {
  // Regression guard for the released breakage: `attach` referenced a helper it
  // did not define, so this threw and the Host could not publish any Agent.
  const { roots } = harness()
  assert.deepEqual(
    roots[0].listeners.map((item) => item.name),
    ['tools/result'],
  )
})

test('apply survives with no pre-existing Agents', () => {
  const { roots } = harness({ roots: [], rootList: [] })
  assert.equal(roots.length, 0)
})

test('apply registers one root-plane session/event listener', () => {
  const { events } = harness()
  assert.equal(typeof events['session/event'], 'function')
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

  const { warnings, agents } = harness({ roots: [], rootList: [broken, healthy] })

  assert.equal(
    warnings.filter((message) => message.includes('无法为该会话挂载切换器')).length,
    1,
    'exactly one attachment failure must be reported',
  )
  assert.deepEqual(
    healthy.listeners.map((item) => item.name),
    ['tools/result'],
    'a healthy Agent must still be attached after a broken one',
  )
  assert.deepEqual([...agents.keys()].sort(), ['broken', 'healthy'])
})

test('a throwing dispose during teardown does not escape', () => {
  const agent = newAgent('a1')
  const { events } = harness({ roots: [agent] })
  agent.ctx.on = () => {
    throw new Error('dispose failed')
  }
  assert.doesNotThrow(() => events.teardown())
})

test('agent/created attaches and agent/disposed detaches', () => {
  const { events, agents } = harness({ roots: [], rootList: [] })
  const agent = newAgent('late')
  agents.set('late', agent)

  events['agent/created']({ agent })
  assert.deepEqual(agent.listeners.map((item) => item.name), ['tools/result'])

  events['agent/disposed']({ agent })
  assert.deepEqual(agent.listeners, [], 'disposal must unsubscribe every listener')
})

test('subagent Agents are never attached', () => {
  const subagent = newAgent('sub', { origin: 'subagent' })
  const { events } = harness({ roots: [], rootList: [] })

  events['agent/created']({ agent: subagent })
  assert.deepEqual(subagent.listeners, [])
})

// --- the soft rule: entering plan selects Plan -----------------------------

test('entering plan mode selects the Plan route', async () => {
  const agent = newAgent('root-1')
  const { events, calls } = harness({ roots: [agent] })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()

  assert.deepEqual(calls, [{ sessionId: 'root-1', ...PLAN_ROUTE }])
})

test('leaving plan mode never touches the selection', async () => {
  const agent = newAgent('root-1')
  const { events, calls } = harness({ roots: [agent] })

  events['session/event'](agent.session, planMode(agent.session, false))
  await settle()

  assert.deepEqual(calls, [], '/plan off must leave the model alone')
})

test('a plan/mode event for an unknown session is ignored', async () => {
  const { events, calls } = harness({ roots: [newAgent('known')] })

  events['session/event']({ id: 'ghost', header: { cwd: 'C:/work' } }, planMode({}, true))
  await settle()

  assert.deepEqual(calls, [])
})

test('entering plan is skipped when the session already committed the Plan route', async () => {
  const agent = newAgent('root-1')
  const { events, calls } = harness({ roots: [agent], selection: PLAN_ROUTE })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()

  assert.deepEqual(calls, [], 're-selecting the current route must not append an event')
})

test('entering plan keeps a hand-picked effort the configured route leaves open', async () => {
  const agent = newAgent('root-1')
  const picked = { provider: 'cline-pass', model: 'm1', reasoningEffort: 'low' }
  const { events, calls } = harness({
    roots: [agent],
    selection: picked,
    plan: { provider: 'cline-pass', model: 'm1' },
  })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()

  assert.deepEqual(calls, [])
})

// --- the hard rule: an approved plan selects Act ---------------------------

test('an approved plan forces the Act route', async () => {
  const agent = newAgent('root-1')
  const { calls } = harness({ roots: [agent], selection: PLAN_ROUTE })

  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [{ sessionId: 'root-1', ...ACT_ROUTE }])
})

test('an approved plan overrides a hand-picked model in plan mode', async () => {
  const agent = newAgent('root-1')
  const picked = { provider: 'other', model: 'x', reasoningEffort: 'low' }
  const { calls } = harness({ roots: [agent], selection: picked })

  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [{ sessionId: 'root-1', ...ACT_ROUTE }])
})

test('a rejected or kept plan does not switch', async () => {
  const agent = newAgent('root-1')
  const { calls } = harness({ roots: [agent] })

  approvalEvent(agent, { approved: false })
  approvalEvent(agent, {})
  approvalEvent(agent, undefined)
  await settle()

  assert.deepEqual(calls, [])
})

test('a failed exit_plan_mode result does not switch', async () => {
  const agent = newAgent('root-1')
  const { calls } = harness({ roots: [agent] })

  approvalEvent(agent, { approved: true }, { isError: true })
  await settle()

  assert.deepEqual(calls, [])
})

test('other tools never switch, even when they return an approval field', async () => {
  const agent = newAgent('root-1')
  const { calls } = harness({ roots: [agent] })

  approvalEvent(agent, { approved: true }, { name: 'some_other_tool' })
  await settle()

  assert.deepEqual(calls, [])
})

test('an approved plan that already committed the Act route is a no-op', async () => {
  const agent = newAgent('root-1')
  const { calls } = harness({ roots: [agent], selection: ACT_ROUTE })

  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [])
})

// --- custom modes are manual-only -----------------------------------------

/** One complete custom mode, as the settings page would store it. */
const REVIEW_MODE = { m1: { name: '审查', provider: 'local', model: 'reviewer', reasoningEffort: 'low' } }

test('no Host event ever switches *to* a custom mode', async () => {
  // The whole point of the feature: a custom mode is reachable only through the
  // dropdown. Both automatic rules run with the mode present and a selection on
  // it; neither may produce a call that carries the custom route, because the
  // rules only ever name `plan` or `act`.
  const agent = newAgent('root-1')
  const custom = { provider: 'local', model: 'reviewer', reasoningEffort: 'low' }
  const { events, calls } = harness({ roots: [agent], modes: REVIEW_MODE, selection: custom })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()
  approvalEvent(agent, { approved: true })
  await settle()

  assert.equal(
    calls.some((call) => call.provider === custom.provider && call.model === custom.model),
    false,
    'a custom route must never be committed by an automatic rule',
  )
  // They do fire — onto the built-in tracks — which is decision B, pinned below.
  assert.deepEqual(calls.map((call) => call.reasoningEffort), [PLAN_ROUTE.reasoningEffort, ACT_ROUTE.reasoningEffort])
})

test('entering plan mode overrides a custom selection', async () => {
  // Decided with the plan: the two automatic rules keep their meaning, so a
  // custom mode is stepped over rather than honoured on mode entry.
  const agent = newAgent('root-1')
  const { events, calls } = harness({
    roots: [agent],
    modes: REVIEW_MODE,
    selection: { provider: 'local', model: 'reviewer', reasoningEffort: 'low' },
  })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()

  assert.deepEqual(calls, [{ sessionId: 'root-1', ...PLAN_ROUTE }])
})

test('an approved plan overrides a custom selection', async () => {
  const agent = newAgent('root-1')
  const { calls } = harness({
    roots: [agent],
    modes: REVIEW_MODE,
    selection: { provider: 'local', model: 'reviewer', reasoningEffort: 'low' },
  })

  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [{ sessionId: 'root-1', ...ACT_ROUTE }])
})

test('a broken custom mode does not disturb the two automatic rules', async () => {
  // The Host resolves only the built-in tracks when it switches, so an
  // incomplete custom entry must not produce a warning or block either rule.
  const agent = newAgent('root-1')
  const { events, calls, warnings } = harness({
    roots: [agent],
    modes: { m1: { name: '待补', provider: 'local', model: '' } },
  })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()
  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [
    { sessionId: 'root-1', ...PLAN_ROUTE },
    { sessionId: 'root-1', ...ACT_ROUTE },
  ])
  assert.deepEqual(warnings, [])
})

// --- shared stand-aside conditions ----------------------------------------

test('a disabled plugin leaves both automatic rules alone', async () => {
  const agent = newAgent('root-1')
  const { events, calls } = harness({ roots: [agent], enabled: false })

  events['session/event'](agent.session, planMode(agent.session, true))
  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [])
})

test('a project set to off leaves both automatic rules alone', async () => {
  const agent = newAgent('root-1', { cwd: 'C:/work' })
  const { events, calls } = harness({
    roots: [agent],
    projects: { 'c:/work': { mode: 'off', plan: {}, act: {} } },
  })

  events['session/event'](agent.session, planMode(agent.session, true))
  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [])
})

test('an incomplete route is reported once and never reaches selectModel', async () => {
  const agent = newAgent('root-1')
  const { events, calls, warnings } = harness({
    roots: [agent],
    act: { provider: 'cline-pass', model: '' },
  })

  approvalEvent(agent, { approved: true })
  approvalEvent(agent, { approved: true })
  await settle()

  assert.deepEqual(calls, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /不切换|route|provider/)
})

test('a missing sessionController degrades without breaking the event', async () => {
  const agent = newAgent('root-1')
  const { events, warnings } = harness({ roots: [agent], sessionController: null })

  events['session/event'](agent.session, planMode(agent.session, true))
  await settle()

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sessionController/)
})
