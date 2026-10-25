/**
 * Behavioural test for the `window.__ModuleLoader__` bundle.
 *
 * `client.js` cannot be imported like a normal module: it is a bundle that calls
 * `window.__ModuleLoader__.load({ id, factory })`. The other suites only grep its
 * source, which cannot catch a factory that throws or an `apply()` that asks the
 * Host for the wrong namespace — the failure mode that renders "宿主没有提供配置项"
 * with no other symptom.
 *
 * This file fakes the module loader plus the two Services `apply()` touches
 * (`configForms`, `slots`) and asserts what the real code asks for. It pins two
 * invariants: the namespace handed to `configForms.get()` must equal the `id` in
 * `cordis.patch.yml` (`dsh-settings` keys `describe()` by the Loader row id), and
 * the composer chip must render `模式：模型` — asserted by rendering the real
 * component, not by grepping its source.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * A React stand-in. The factory destructures these hooks, and the assertions
 * render the chip with a settled snapshot, so `useEffect` stays inert: the
 * catalog arrives through `loadCatalog` instead of an effect.
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
}

/** Load the bundle and return the declaration it registers. */
let loads = 0
async function loadDeclaration() {
  let declaration
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        declaration = value
      },
    },
  }
  globalThis.document = { addEventListener() {}, removeEventListener() {} }
  // A fresh query string defeats the ESM module cache: the bundle has to run
  // again for each test, because its whole effect is the single `load()` call.
  loads += 1
  await import(`${pathToFileURL(join(root, 'client.js')).href}?case=${loads}`)
  assert.ok(declaration, 'client.js must call window.__ModuleLoader__.load once')
  return declaration
}

/** The row id `cordis.patch.yml` declares; the settings namespace must match it. */
function rowId() {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const declared = patch.match(/^\s*-\s*id:\s*(\S+)$/m)?.[1]
  assert.ok(declared, 'cordis.patch.yml must declare an insert row id')
  return declared
}

/**
 * Run `apply()` against a fake Host.
 * @param form - what `configForms.get()` returns.
 * @param catalog - what `modelCatalog()` resolves to; `undefined` omits the method.
 * @returns the registered specs (with their component), the seats, and the namespaces asked for.
 */
async function mount(form, catalog) {
  const declaration = await loadDeclaration()
  const module = declaration.factory((specifier) => {
    assert.equal(specifier, 'react', 'the bundle must only require react')
    return fakeReact()
  })

  const asked = []
  const registered = []
  const seats = []
  const ctx = {
    configForms: {
      get(namespace) {
        asked.push(namespace)
        return form
      },
    },
    slots: {
      inject(seat, callback) {
        seats.push(seat)
        callback()
        return () => {}
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
    remote:
      catalog === undefined
        ? {}
        : { session: { modelCatalog: async () => ({ ok: true, value: catalog }) } },
  }

  module.apply(ctx)
  return { declaration, asked, registered, seats }
}

/** A configForms snapshot the chip accepts as settled. */
function readyForm(value) {
  return {
    getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true }),
    subscribe: () => () => {},
  }
}

/** Flatten the text a `createElement` tree renders. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

/** The one `conversation.input.right` registration. */
function chipOf(registered) {
  const found = registered.find((item) => item.spec.name === 'conversation.input.right')
  assert.ok(found, 'the composer chip must be registered')
  return found
}

/**
 * Render the chip once.
 * @param registered - what `mount()` collected.
 * @param props.plan - the `plan` projection value.
 * @param props.row - the session list row (cwd and lineage).
 * @param props.sessionId - the bound session.
 */
function renderChip(registered, props) {
  const { spec, component } = chipOf(registered)
  const injected = spec.inject()
  const element = component({
    ...injected,
    useProjection: (key) => (key === 'plan' ? props.plan : undefined),
    useSessions: (select) => select({ byId: { [props.sessionId]: props.row } }),
    sessionId: props.sessionId,
  })
  return { element, text: textOf(element), injected }
}

const MODEL = 'deepseek-v4.1-flash-1017'
const ROUTE_PAIR = {
  enabled: true,
  plan: { provider: 'cline-pass', model: MODEL, reasoningEffort: 'max' },
  act: { provider: 'cline-pass', model: MODEL, reasoningEffort: 'high' },
  projects: {},
}
const CATALOG = {
  groups: [{ id: 'cline-pass', models: [{ id: MODEL, name: 'DeepSeek V4.1 Flash' }] }],
}

test('the bundle declares the package id and its Services', async () => {
  const declaration = await loadDeclaration()
  assert.equal(declaration.id, 'dsh-plan-act-models')
  assert.equal(typeof declaration.factory, 'function')
})

test('apply() asks the Host for the namespace cordis.patch.yml declares', async () => {
  const { asked, registered, seats } = await mount({ getSnapshot: () => ({ status: 'loading' }) })

  assert.deepEqual(asked, [rowId()], 'configForms.get() must use the Loader row id')
  assert.deepEqual([...seats].sort(), ['conversation.input.right', 'settings.section'])
  assert.equal(registered.length, 2, 'the settings page and the composer chip')
})

test('the settings page keeps its id, order and label', async () => {
  const { registered } = await mount({ getSnapshot: () => ({ status: 'loading' }) })
  const settings = registered.find((item) => item.spec.name === 'settings.section')
  assert.ok(settings, 'a settings section must be registered')
  assert.equal(settings.spec.id, rowId())
  assert.equal(typeof settings.spec.label, 'function')
  assert.match(settings.spec.label(), /Plan \/ Act/)
})

test('the chip registers beside the native model selector', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const { spec, component } = chipOf(registered)
  assert.equal(spec.id, 'plan-act-route')
  assert.equal(typeof spec.order, 'number')
  assert.equal(typeof spec.inject, 'function')
  assert.equal(typeof component, 'function')
  const injected = spec.inject()
  assert.equal(injected.form.getSnapshot().status, 'ready', 'the chip reads the shared form')
  assert.equal(typeof injected.loadCatalog, 'function')
})

test('the chip renders `模式：模型` from the committed mode and the resolved route', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))

  const plan = renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: true } })
  assert.equal(plan.text, 'Plan：deepseek-v4.1-flash-1017', 'without a catalog the model id stands in')
  assert.equal(plan.element.type, 'span')

  const act = renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: false } })
  assert.equal(act.text, 'Act：deepseek-v4.1-flash-1017')

  // The projection is absent for a session the Host has not published yet.
  assert.equal(
    renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: undefined }).text,
    'Act：deepseek-v4.1-flash-1017',
  )
})

test('the chip falls back to the model id when the catalog has no display name', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG)
  const rendered = renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: true } })
  assert.equal(rendered.text, 'Plan：deepseek-v4.1-flash-1017')
  assert.match(rendered.element.props.title, /^Plan：deepseek-v4\.1-flash-1017 — cline-pass\/deepseek-v4/)
})

test('the hover title names the exact provider, model, effort and scope', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const rendered = renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: true } })
  assert.equal(
    rendered.element.props.title,
    'Plan：deepseek-v4.1-flash-1017 — cline-pass/deepseek-v4.1-flash-1017 (max) · 全局配置',
  )
})

test('a project override is reflected in the chip and its title', async () => {
  const value = {
    ...ROUTE_PAIR,
    projects: {
      'c:/work': {
        mode: 'override',
        plan: { provider: 'other', model: 'pinned-model' },
        act: { provider: 'other', model: 'pinned-model' },
      },
    },
  }
  const { registered } = await mount(readyForm(value))
  const rendered = renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/Work' }, plan: { active: true } })
  assert.equal(rendered.text, 'Plan：pinned-model')
  assert.match(rendered.element.props.title, /· 项目覆盖：c:\/work$/)
})

test('the chip hides on a subagent session and while settings are unsettled', async () => {
  const unsettled = await mount({ getSnapshot: () => ({ status: 'loading' }) })
  assert.equal(
    renderChip(unsettled.registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: true } }).element,
    null,
    'nothing is shown before the settings mirror resolves',
  )
  const unavailable = await mount({ getSnapshot: () => ({ status: 'unavailable' }) })
  assert.equal(
    renderChip(unavailable.registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: true } }).element,
    null,
  )

  const { registered } = await mount(readyForm(ROUTE_PAIR))
  assert.equal(
    renderChip(registered, { sessionId: 'child', row: { cwd: 'C:/work', origin: 'subagent' }, plan: { active: true } })
      .element,
    null,
    'subagent sessions are never routed',
  )
  assert.equal(
    renderChip(registered, { sessionId: 'child', row: { cwd: 'C:/work', parentId: 'root' }, plan: { active: true } })
      .element,
    null,
  )
})

test('the chip reports the degraded states instead of a stale model', async () => {
  const cases = [
    { value: { ...ROUTE_PAIR, enabled: false }, expected: 'Plan：已关闭' },
    { value: { ...ROUTE_PAIR, projects: { 'c:/work': { mode: 'off' } } }, expected: 'Plan：此项目已停用' },
    { value: { ...ROUTE_PAIR, plan: { provider: 'cline-pass', model: '' } }, expected: 'Plan：未配置' },
  ]
  for (const item of cases) {
    const { registered } = await mount(readyForm(item.value))
    assert.equal(
      renderChip(registered, { sessionId: 's1', row: { cwd: 'C:/work' }, plan: { active: true } }).text,
      item.expected,
    )
  }
})
