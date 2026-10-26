/**
 * Behavioural test for the `window.__ModuleLoader__` bundle.
 *
 * `client.js` cannot be imported like a normal module: it is a bundle that calls
 * `window.__ModuleLoader__.load({ id, factory })`. The other suites only grep its
 * source, which cannot catch a factory that throws or an `apply()` that asks the
 * Host for the wrong namespace — the failure mode that renders "宿主没有提供配置项"
 * with no other symptom.
 *
 * This file fakes the module loader plus the Services `apply()` touches
 * (`configForms`, `slots`, `remote`) and asserts what the real code asks for. It
 * pins three invariants: the namespace handed to `configForms.get()` must equal
 * the `id` in `cordis.patch.yml` (`dsh-settings` keys `describe()` by the Loader
 * row id); the composer control must be a real `<select>` whose entries read
 * `模式：模型`; and a pick must go through the Host's own `session.selectModel`,
 * not through an event of our own.
 *
 * The React stand-in is a minimal hooks renderer (state, effects, a re-render
 * loop) rather than an inert stub, because half of what the control does —
 * loading the catalog, showing a failure — only becomes visible on a second
 * pass. An inert stub would silently pass those tests with `null`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The hook store of the component being rendered right now. */
let hooks = null

/**
 * A React stand-in with just enough of the hook model to re-render.
 *
 * `useEffect` runs the effect immediately (no deps tracking) and `useState`
 * records writes, setting `dirty` so the render loop knows to go around again.
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      if (hooks === null) return undefined
      const cleanup = fn()
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup)
      return cleanup
    },
    useMemo: (fn) => fn(),
    useState: (initial) => {
      // Captured per call, the way React's dispatcher binds a setter to the
      // running store: a setter invoked after the render would otherwise read a
      // `hooks` that has already been restored.
      const store = hooks
      const index = store.next
      store.next += 1
      if (!(index in store.states)) {
        store.states[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(store.states[index]) : next
        if (value === store.states[index]) return
        store.states[index] = value
        store.dirty = true
      }
      return [store.states[index], set]
    },
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
 * @param selectModel - what `session.selectModel()` replies; `undefined` omits the method.
 * @returns the registered specs (with their component), the seats, the namespaces asked for, and the calls made.
 */
async function mount(form, catalog, selectModel) {
  const declaration = await loadDeclaration()
  const react = fakeReact()
  const module = declaration.factory((specifier) => {
    assert.equal(specifier, 'react', 'the bundle must only require react')
    return react
  })

  const asked = []
  const registered = []
  const seats = []
  const selected = []
  const session = {}
  if (catalog !== undefined) session.modelCatalog = async () => ({ ok: true, value: catalog })
  if (selectModel !== undefined) {
    session.selectModel = async (request) => {
      selected.push(request)
      return selectModel(request)
    }
  }

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
    remote: { session },
  }

  module.apply(ctx)
  return { declaration, asked, registered, seats, selected }
}

/** A configForms snapshot the control accepts as settled. */
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
  assert.ok(found, 'the composer control must be registered')
  return found
}

/** The `<select>` inside a rendered control. */
function selectOf(element) {
  assert.ok(element, 'the control must render an element')
  const select = (element.children ?? []).find((child) => child?.type === 'select')
  assert.ok(select, 'the control must render a native <select>')
  return select
}

/** The `<option>` entries of a rendered control, keyed by value. */
function optionsOf(element) {
  const byValue = {}
  // `createElement('select', props, options.map(…))` passes one array child, so
  // the flat list has to be unwrapped before it can be keyed.
  for (const child of selectOf(element).children.flat(Infinity)) {
    if (child?.type !== 'option') continue
    byValue[child.props.value] = child
  }
  return byValue
}

/**
 * Render the control, letting its effects settle.
 *
 * Re-renders while the hook store reports a write, so a catalog that arrives
 * from a promise is visible — exactly the case an inert `useEffect` would hide.
 * @param registered - what `mount()` collected.
 * @param props.plan - the `plan` projection value.
 * @param props.selection - the `modelSelection` projection value.
 * @param props.row - the session list row (cwd and lineage).
 * @param props.sessionId - the bound session.
 */
async function renderChip(registered, props) {
  const { spec, component } = chipOf(registered)
  const injected = spec.inject()
  const store = { states: [], next: 0, dirty: true, cleanups: [] }
  let element = null

  async function pass() {
    for (let round = 0; round < 8; round += 1) {
      store.next = 0
      store.dirty = false
      const previous = hooks
      hooks = store
      try {
        element = component({
          ...injected,
          useProjection: (key) =>
            key === 'plan' ? props.plan : key === 'modelSelection' ? props.selection : undefined,
          useSessions: (select) => select({ byId: { [props.sessionId]: props.row } }),
          sessionId: props.sessionId,
        })
      } finally {
        hooks = previous
      }
      // Effects start promises (the catalog read); give them a turn before
      // deciding whether another pass is needed.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (store.dirty === false) break
    }
    return element
  }

  await pass()
  return {
    get element() {
      return element
    },
    get text() {
      return textOf(element)
    },
    injected,
    rerender: pass,
  }
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
const ON_PLAN = { next: { provider: 'cline-pass', model: MODEL, reasoningEffort: 'max' }, lastUsed: null }
const ON_ACT = { next: { provider: 'cline-pass', model: MODEL, reasoningEffort: 'high' }, lastUsed: null }
const NOWHERE = { next: { provider: 'other', model: 'stray', reasoningEffort: 'low' }, lastUsed: null }

test('the bundle declares the package id and its Services', async () => {
  const declaration = await loadDeclaration()
  assert.equal(declaration.id, 'dsh-plan-act-models')
  assert.equal(typeof declaration.factory, 'function')
})

test('apply() asks the Host for the namespace cordis.patch.yml declares', async () => {
  const { asked, registered, seats } = await mount({ getSnapshot: () => ({ status: 'loading' }) })

  assert.deepEqual(asked, [rowId()], 'configForms.get() must use the Loader row id')
  assert.deepEqual([...seats].sort(), ['conversation.input.right', 'settings.section'])
  assert.equal(registered.length, 2, 'the settings page and the composer control')
})

test('the settings page keeps its id, order and label', async () => {
  const { registered } = await mount({ getSnapshot: () => ({ status: 'loading' }) })
  const settings = registered.find((item) => item.spec.name === 'settings.section')
  assert.ok(settings, 'a settings section must be registered')
  assert.equal(settings.spec.id, rowId())
  assert.equal(typeof settings.spec.label, 'function')
  assert.match(settings.spec.label(), /Plan \/ Act/)
})

test('the control registers beside the native model selector', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const { spec, component } = chipOf(registered)
  assert.equal(spec.id, 'plan-act-route')
  assert.equal(typeof spec.order, 'number')
  assert.equal(typeof spec.inject, 'function')
  assert.equal(typeof component, 'function')
  const injected = spec.inject()
  assert.equal(injected.form.getSnapshot().status, 'ready', 'the control reads the shared form')
  assert.equal(typeof injected.loadCatalog, 'function')
  assert.equal(typeof injected.select, 'function', 'the control needs a way to commit a route')
})

test('the committed selection decides which entry is shown', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))

  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  assert.equal(selectOf(plan.element).props.value, 'plan')

  const act = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: false },
    selection: ON_ACT,
  })
  assert.equal(selectOf(act.element).props.value, 'act')
})

test('the control does not follow plan mode, only the committed selection', async () => {
  // The whole point of this change: leaving plan mode no longer decides the
  // model, and entering it does not either. Being in plan mode while the
  // selection is the Act route must show `act`.
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_ACT,
  })
  assert.equal(selectOf(rendered.element).props.value, 'act')
})

test('the entries read `模式：模型` with a full-width colon', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  const options = optionsOf(plan.element)
  assert.equal(textOf(options.plan), `Plan：${MODEL}`)
  assert.equal(textOf(options.act), `Act：${MODEL}`)
  assert.equal(options.custom, undefined, 'the placeholder only appears when neither entry matches')
})

test('the entries use the catalog display name when one exists', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  assert.equal(textOf(optionsOf(plan.element).plan), 'Plan：DeepSeek V4.1 Flash')
})

test('a selection matching neither entry shows a disabled placeholder naming it', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: NOWHERE,
  })
  assert.equal(selectOf(rendered.element).props.value, 'custom')
  const custom = optionsOf(rendered.element).custom
  assert.ok(custom, 'a placeholder entry must exist')
  assert.equal(custom.props.disabled, true, 'the placeholder is not a third choice')
  assert.equal(textOf(custom), '自定义：stray')
  assert.match(rendered.element.props.title, /^自定义 — other\/stray \(low\)$/)
})

test('picking an entry commits it through session.selectModel', async () => {
  const { registered, selected } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  await selectOf(plan.element).props.onChange({ target: { value: 'act' } })

  assert.deepEqual(selected, [
    { sessionId: 's1', provider: 'cline-pass', model: MODEL, reasoningEffort: 'high' },
  ])
})

test('picking the entry already shown does nothing', async () => {
  const { registered, selected } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  await selectOf(plan.element).props.onChange({ target: { value: 'plan' } })
  assert.deepEqual(selected, [], 'an unchanged pick must not append a model/selection event')
})

test('a route with no effort omits the field instead of sending an empty string', async () => {
  const value = { ...ROUTE_PAIR, act: { provider: 'cline-pass', model: MODEL } }
  const { registered, selected } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  await selectOf(plan.element).props.onChange({ target: { value: 'act' } })
  assert.deepEqual(selected, [{ sessionId: 's1', provider: 'cline-pass', model: MODEL }])
})

test('an incomplete entry is shown but not selectable', async () => {
  const value = { ...ROUTE_PAIR, plan: { provider: 'cline-pass', model: '' } }
  const { registered } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_ACT,
  })
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props.disabled, true)
  assert.equal(textOf(options.plan), 'Plan：未配置')
  assert.equal(options.act.props.disabled, false)
})

test('a project set to off disables both entries and says so', async () => {
  const value = { ...ROUTE_PAIR, projects: { 'c:/work': { mode: 'off' } } }
  const { registered } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_ACT,
  })
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props.disabled, true)
  assert.equal(options.act.props.disabled, true)
  assert.equal(textOf(options.plan), 'Plan：此项目已停用')
})

test('without selectModel in the Host the entries say why they are inert', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG)
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props.disabled, true)
  assert.equal(options.act.props.disabled, true)
  assert.match(rendered.element.props.title, /· 宿主不支持切换模型$/)
})

test('the hover title names the exact provider, model, effort and scope', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  assert.equal(
    rendered.element.props.title,
    `Plan：DeepSeek V4.1 Flash — cline-pass/${MODEL} (max) · 全局配置`,
    'the label uses the display name, the title the exact ids',
  )
})

test('a project override is reflected in the label and the title', async () => {
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
  const { registered } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/Work' },
    plan: { active: true },
    selection: { next: { provider: 'other', model: 'pinned-model' }, lastUsed: null },
  })
  assert.equal(textOf(optionsOf(rendered.element).plan), 'Plan：pinned-model')
  assert.match(rendered.element.props.title, /· 项目覆盖：c:\/work$/)
})

test('the control hides on a subagent session and while settings are unsettled', async () => {
  const unsettled = await mount({ getSnapshot: () => ({ status: 'loading' }) })
  assert.equal(
    (
      await renderChip(unsettled.registered, {
        sessionId: 's1',
        row: { cwd: 'C:/work' },
        plan: { active: true },
        selection: ON_PLAN,
      })
    ).element,
    null,
    'nothing is shown before the settings mirror resolves',
  )
  const unavailable = await mount({ getSnapshot: () => ({ status: 'unavailable' }) })
  assert.equal(
    (
      await renderChip(unavailable.registered, {
        sessionId: 's1',
        row: { cwd: 'C:/work' },
        plan: { active: true },
        selection: ON_PLAN,
      })
    ).element,
    null,
  )

  const { registered } = await mount(readyForm(ROUTE_PAIR))
  assert.equal(
    (
      await renderChip(registered, {
        sessionId: 'child',
        row: { cwd: 'C:/work', origin: 'subagent' },
        plan: { active: true },
        selection: ON_PLAN,
      })
    ).element,
    null,
    'subagent sessions are never switched',
  )
  assert.equal(
    (
      await renderChip(registered, {
        sessionId: 'child',
        row: { cwd: 'C:/work', parentId: 'root' },
        plan: { active: true },
        selection: ON_PLAN,
      })
    ).element,
    null,
  )
})

test('turning automatic switching off does not disable the dropdown', async () => {
  const value = { ...ROUTE_PAIR, enabled: false }
  const { registered } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  assert.equal(selectOf(rendered.element).props.disabled, false, 'a manual pick always works')
  assert.equal(optionsOf(rendered.element).act.props.disabled, false)
  assert.match(rendered.element.props.title, /· 自动切换已关闭$/)
  assert.doesNotMatch(rendered.text, /已关闭/)
})

test('a rejected pick is shown beside the control', async () => {
  const reply = { ok: false, error: { code: 'session/model-unavailable', message: '模型不可用' } }
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => reply)
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  await selectOf(rendered.element).props.onChange({ target: { value: 'act' } })
  await rendered.rerender()
  assert.match(rendered.text, /session\/model-unavailable: 模型不可用/)
  assert.match(rendered.element.props.title, /session\/model-unavailable: 模型不可用$/)
})
