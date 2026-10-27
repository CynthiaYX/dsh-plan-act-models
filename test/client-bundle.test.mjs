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
 * pins four invariants: the namespace handed to `configForms.get()` must equal
 * the `id` in `cordis.patch.yml` (`dsh-settings` keys `describe()` by the Loader
 * row id); the composer control is a themed chip — a `button` plus a hand-rolled
 * `listbox`, never a native `<select>`, whose entries still read `模式：模型`; a
 * pick must go through the Host's own `session.selectModel`, not through an
 * event of our own; and the stylesheet is added exactly once, from the factory.
 *
 * The React stand-in is a minimal hooks renderer (state, effects, refs, a
 * re-render loop) rather than an inert stub, because half of what the control
 * does — loading the catalog, opening the menu, showing a failure — only becomes
 * visible on a second pass. An inert stub would silently pass those tests with
 * `null`.
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
 * `useEffect` runs when its dependency list changed (and always on the first
 * pass), the way React does. An effect that re-ran on every render would quietly
 * undo what a settings field just did: the page syncs its draft from the config
 * snapshot in exactly such an effect. `useState` records writes, setting `dirty`
 * so the render loop knows to go around again.
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol.for('pam.fragment'),
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => {
      if (hooks === null) return undefined
      const index = hooks.next
      hooks.next += 1
      if (deps !== undefined && sameDeps(hooks.effects[index], deps)) return undefined
      hooks.effects[index] = deps
      const cleanup = fn()
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup)
      return cleanup
    },
    useMemo: (fn) => fn(),
    useRef: (initial) => {
      const store = hooks
      const index = store.next
      store.next += 1
      if (!(index in store.refs)) store.refs[index] = { current: initial }
      return store.refs[index]
    },
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

/** Shallow dependency-list comparison, the rule React uses for `useEffect`. */
function sameDeps(previous, next) {
  if (previous === undefined || previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

/**
 * A `document` that records what the bundle does to it.
 *
 * The chip injects a `<style>` from its factory and closes its menu on an
 * outside `pointerdown`, so the fake keeps the appended tags (keyed the way the
 * real `querySelector` finds them) and the listeners, and lets a test fire one.
 */
function fakeDocument() {
  const tags = []
  const listeners = new Map()
  const styleSelector = (tag) => styleSelectorFor(tag.dataset.pluginCss)
  return {
    tags,
    head: {
      appendChild(tag) {
        tags.push(tag)
      },
    },
    createElement(tagName) {
      return { type: tagName, dataset: {}, textContent: '' }
    },
    querySelector(selector) {
      return tags.find((tag) => styleSelector(tag) === selector) ?? null
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener))
    },
    /** Deliver one event to every listener of `type`. */
    fire(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
  }
}

/** The selector the bundle looks up for one stylesheet id. */
function styleSelectorFor(id) {
  return `style[data-plugin-css=${JSON.stringify(id)}]`
}

/** The document installed by the most recent `loadDeclaration()`. */
let activeDocument = null

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
  activeDocument = fakeDocument()
  globalThis.document = activeDocument
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
 * @returns the registered specs (with their component), the seats, the namespaces asked for, the calls made, and the faked pieces.
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
  return { declaration, module, asked, registered, seats, selected, styles: activeDocument.tags }
}

/** A configForms snapshot the control accepts as settled. */
function readyForm(value) {
  return {
    getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true }),
    subscribe: () => () => {},
  }
}

/** Flatten the text a `createElement` tree renders, expanding function components. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }))
  return (node.children ?? []).map(textOf).join('')
}

/** The one `conversation.input.right` registration. */
function chipOf(registered) {
  const found = registered.find((item) => item.spec.name === 'conversation.input.right')
  assert.ok(found, 'the composer control must be registered')
  return found
}

/** The chip frame: `<span class="pam-chip">`. */
function chipOfElement(element) {
  assert.ok(element, 'the control must render an element')
  assert.equal(element.type, 'span')
  assert.equal(element.props.className, 'pam-chip')
  return element
}

/** The trigger button of a rendered chip. */
function triggerOf(element) {
  const trigger = (chipOfElement(element).children ?? []).find(
    (child) => child?.type === 'button' && child.props.className === 'pam-trigger',
  )
  assert.ok(trigger, 'the control must render a <button class="pam-trigger">')
  return trigger
}

/** The open menu of a rendered chip, or `null` when it is closed. */
function menuOf(element) {
  return (
    (chipOfElement(element).children ?? []).find(
      (child) => child?.type === 'div' && child.props.className === 'pam-menu',
    ) ?? null
  )
}

/** The `role="option"` rows of an open menu, in render order. */
function optionListOf(element) {
  const menu = menuOf(element)
  assert.ok(menu, 'the menu must be open before its options can be read')
  // `createElement('div', props, options.map(…))` passes one array child, so the
  // flat list has to be unwrapped before it can be filtered.
  return menu.children.flat(Infinity).filter((child) => child?.type === 'button' && child.props.role === 'option')
}

/**
 * The rows keyed by what identifies them: `plan`, `act`, the `custom`
 * placeholder, or a custom mode's id.
 *
 * Custom modes all share the `mode` tone, so the tone alone cannot key them;
 * `data-mode-id` is what the renderer puts on a row for exactly this reason.
 */
function optionsOf(element) {
  const byId = {}
  for (const child of optionListOf(element)) {
    const id = child.props['data-mode-id']
    if (id !== undefined) byId[id] = child
    else byId[child.props['data-tone']] = child
  }
  return byId
}

/** Simulate a key press the way React would deliver one. */
function key(name) {
  return { key: name, preventDefault() {} }
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
  const store = { states: [], refs: [], effects: [], next: 0, dirty: true, cleanups: [] }
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

/** Click the trigger and settle the re-render, leaving the menu open. */
async function openChip(rendered) {
  triggerOf(rendered.element).props.onClick()
  await rendered.rerender()
  assert.ok(menuOf(rendered.element), 'clicking the trigger must open the menu')
  return rendered
}

/**
 * Render the settings page, letting its effects settle.
 *
 * Same hook store as {@link renderChip}; `form.mutate` records what the page
 * would write, which is the only way to see the payload a custom mode produces.
 * @param registered - what `mount()` collected.
 * @param value - the current config, as the Host reports it.
 */
async function renderSettings(registered, value) {
  const settings = registered.find((item) => item.spec.name === 'settings.section')
  assert.ok(settings, 'a settings section must be registered')
  const writes = []
  const form = {
    getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async (patches, revision) => {
      writes.push({ patches, revision })
      return true
    },
  }
  const injected = settings.spec.inject()
  const store = { states: [], refs: [], effects: [], next: 0, dirty: true, cleanups: [] }
  let element = null

  async function pass() {
    for (let round = 0; round < 8; round += 1) {
      store.next = 0
      store.dirty = false
      const previous = hooks
      hooks = store
      try {
        element = settings.component({ ...injected, form })
      } finally {
        hooks = previous
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (store.dirty === false) break
    }
    return element
  }

  await pass()
  return {
    writes,
    get element() {
      return element
    },
    get text() {
      return textOf(element)
    },
    rerender: pass,
  }
}

/** Every element carrying a `data-mode-id`, i.e. one custom-mode card per mode. */
function modeCardsOf(element) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') return
    if (node.props?.['data-mode-id'] !== undefined) found.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(element)
  return found
}

/** Every `input` in a rendered tree. */
function inputsOf(element) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') return
    if (node.type === 'input') found.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(element)
  return found
}

/** Find the one button whose text is `label` and press it. */
function clickButton(element, label) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') return
    if (node.type === 'button' && textOf(node) === label) found.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(element)
  assert.equal(found.length, 1, `expected exactly one button labelled ${label}`)
  found[0].props.onClick()
}

/** The single `set` payload a save wrote. */
function savedValue(writes) {
  assert.equal(writes.length, 1, 'exactly one save must have been written')
  return writes[0].patches[0].value
}

/** The `settings.section` page of a bundle mounted against a ready form. */
async function settingsOf(value) {
  const { registered } = await mount(readyForm(value), CATALOG)
  return renderSettings(registered, value)
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
  // The page is no longer only about the two fixed tracks, so the label stopped
  // saying so; it names the subject, not the feature count.
  assert.match(settings.spec.label(), /模式/)
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

test('the stylesheet is injected from the factory, once, and names the chip classes', async () => {
  const { module, styles } = await mount(readyForm(ROUTE_PAIR))
  assert.equal(styles.length, 1, 'the factory must add exactly one <style>')
  const tag = styles[0]
  assert.equal(tag.type, 'style')
  assert.equal(tag.dataset.plugin, 'dsh-plan-act-models')
  assert.equal(tag.dataset.pluginCss, 'dsh-plan-act-models/chip.css')
  for (const klass of ['.pam-chip', '.pam-trigger', '.pam-menu', '.pam-option']) {
    assert.ok(tag.textContent.includes(klass), `${klass} must be styled`)
  }
  assert.match(tag.textContent, /--dsw-alias-state-business-primary/, 'Plan keeps the blue accent')
  assert.match(tag.textContent, /--dsw-alias-state-success-primary/, 'Act keeps the green accent')
  assert.match(tag.textContent, /--dsw-alias-state-warn-primary/, 'custom modes get an accent of their own')

  // A second apply() on the same module (an HMR re-materialization) must find
  // the existing tag instead of stacking a duplicate copy of the rules.
  const ctx = {
    configForms: { get: () => readyForm(ROUTE_PAIR) },
    slots: { inject: (seat, callback) => callback(), register: () => () => {} },
    remote: { session: {} },
  }
  module.apply(ctx)
  assert.equal(styles.length, 1, 'the stylesheet must not be injected twice')
})

test('the committed selection decides which entry is shown', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))

  const plan = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  assert.equal(triggerOf(plan.element).props['data-tone'], 'plan')

  const act = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: false },
    selection: ON_ACT,
  })
  assert.equal(triggerOf(act.element).props['data-tone'], 'act')
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
  assert.equal(triggerOf(rendered.element).props['data-tone'], 'act')
})

test('the menu stays closed until the trigger is pressed', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  assert.equal(menuOf(rendered.element), null, 'no popup is rendered up front')
  assert.equal(triggerOf(rendered.element).props['aria-expanded'], 'false')
  assert.equal(triggerOf(rendered.element).props['aria-haspopup'], 'listbox')
  assert.equal(triggerOf(rendered.element).type, 'button')
  assert.equal(triggerOf(rendered.element).props.disabled, false)
})

test('opening shows a listbox whose current entry is the selected one', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  const menu = menuOf(rendered.element)
  assert.equal(menu.props.role, 'listbox')
  assert.equal(triggerOf(rendered.element).props['aria-expanded'], 'true')
  assert.equal(triggerOf(rendered.element).props['aria-controls'], menu.props.id)
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props['aria-selected'], 'true')
  assert.equal(options.act.props['aria-selected'], 'false')
})

test('the entries read `模式：模型` with a full-width colon', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR))
  const plan = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  const options = optionsOf(plan.element)
  assert.equal(textOf(options.plan), `Plan：${MODEL}`)
  assert.equal(textOf(options.act), `Act：${MODEL}`)
  assert.equal(options.custom, undefined, 'the placeholder only appears when neither entry matches')
  assert.equal(textOf(triggerOf(plan.element)), `Plan：${MODEL}`)
})

test('the entries use the catalog display name when one exists', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  assert.equal(textOf(optionsOf(plan.element).plan), 'Plan：DeepSeek V4.1 Flash')
})

test('a selection matching neither entry shows a disabled placeholder naming it', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: NOWHERE,
    }),
  )
  assert.equal(triggerOf(rendered.element).props['data-tone'], 'custom')
  const custom = optionsOf(rendered.element).custom
  assert.ok(custom, 'a placeholder entry must exist')
  assert.equal(custom.props.disabled, true, 'the placeholder is not a third choice')
  assert.equal(custom.props['aria-selected'], 'true')
  assert.equal(textOf(custom), '自定义：stray')
  assert.match(rendered.element.props.title, /^自定义 — other\/stray \(low\)$/)
})

test('picking an entry commits it through session.selectModel', async () => {
  const { registered, selected } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  optionsOf(plan.element).act.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(selected, [
    { sessionId: 's1', provider: 'cline-pass', model: MODEL, reasoningEffort: 'high' },
  ])
})

test('picking an entry closes the menu', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  optionsOf(rendered.element).act.props.onClick()
  await rendered.rerender()
  assert.equal(menuOf(rendered.element), null, 'committing dismisses the menu')
  assert.equal(triggerOf(rendered.element).props['aria-expanded'], 'false')
})

test('picking the entry already shown does nothing', async () => {
  const { registered, selected } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  optionsOf(plan.element).plan.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(selected, [], 'an unchanged pick must not append a model/selection event')
})

test('a route with no effort omits the field instead of sending an empty string', async () => {
  const value = { ...ROUTE_PAIR, act: { provider: 'cline-pass', model: MODEL } }
  const { registered, selected } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const plan = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  optionsOf(plan.element).act.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(selected, [{ sessionId: 's1', provider: 'cline-pass', model: MODEL }])
})

test('an incomplete entry is shown but not selectable', async () => {
  const value = { ...ROUTE_PAIR, plan: { provider: 'cline-pass', model: '' } }
  const { registered } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_ACT,
    }),
  )
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props.disabled, true)
  assert.equal(options.plan.props['aria-disabled'], 'true')
  assert.equal(textOf(options.plan), 'Plan：未配置')
  assert.equal(options.act.props.disabled, false)
})

test('a project set to off disables both entries and says so', async () => {
  const value = { ...ROUTE_PAIR, projects: { 'c:/work': { mode: 'off' } } }
  const { registered } = await mount(readyForm(value), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_ACT,
    }),
  )
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props.disabled, true)
  assert.equal(options.act.props.disabled, true)
  assert.equal(textOf(options.plan), 'Plan：此项目已停用')
})

test('without selectModel in the Host the entries say why they are inert', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG)
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  const options = optionsOf(rendered.element)
  assert.equal(options.plan.props.disabled, true)
  assert.equal(options.act.props.disabled, true)
  assert.equal(triggerOf(rendered.element).props['aria-disabled'], 'true')
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
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/Work' },
      plan: { active: true },
      selection: { next: { provider: 'other', model: 'pinned-model' }, lastUsed: null },
    }),
  )
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
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  assert.equal(triggerOf(rendered.element).props.disabled, false, 'a manual pick always works')
  assert.equal(optionsOf(rendered.element).act.props.disabled, false)
  assert.match(rendered.element.props.title, /· 自动切换已关闭$/)
  assert.doesNotMatch(rendered.text, /已关闭/)
})

test('a rejected pick is shown beside the control', async () => {
  const reply = { ok: false, error: { code: 'session/model-unavailable', message: '模型不可用' } }
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => reply)
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  optionsOf(rendered.element).act.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await rendered.rerender()
  assert.match(rendered.text, /session\/model-unavailable: 模型不可用/)
  assert.match(rendered.element.props.title, /session\/model-unavailable: 模型不可用$/)
  const failure = (chipOfElement(rendered.element).children ?? []).find(
    (child) => child?.props?.className === 'pam-failure',
  )
  assert.ok(failure, 'the failure keeps its own element so it can be styled and truncated')
})

test('Escape closes the menu without touching the selection', async () => {
  const { registered, selected } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  menuOf(rendered.element).props.onKeyDown(key('Escape'))
  await rendered.rerender()
  assert.equal(menuOf(rendered.element), null)
  assert.deepEqual(selected, [])
})

test('the keyboard can open, walk the entries and commit with Enter', async () => {
  const { registered, selected } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: true },
    selection: ON_PLAN,
  })
  // ArrowDown on the closed trigger opens the menu on the current entry.
  triggerOf(rendered.element).props.onKeyDown(key('ArrowDown'))
  await rendered.rerender()
  assert.ok(menuOf(rendered.element), 'ArrowDown must open the menu')
  // One more ArrowDown lands on the next selectable row…
  menuOf(rendered.element).props.onKeyDown(key('ArrowDown'))
  await rendered.rerender()
  const active = optionsOf(rendered.element).act
  assert.equal(active.props['data-active'], 'true')
  // …and Enter commits it.
  menuOf(rendered.element).props.onKeyDown(key('Enter'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(selected, [
    { sessionId: 's1', provider: 'cline-pass', model: MODEL, reasoningEffort: 'high' },
  ])
})

test('a pointer press outside the chip closes the menu', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  globalThis.document.fire('pointerdown', { target: {} })
  await rendered.rerender()
  assert.equal(menuOf(rendered.element), null, 'an outside press dismisses the menu')
  assert.equal(globalThis.document.tags.length, 1, 'the dismissal must not re-inject styles')
})

test('a pending pick disables the trigger so a double commit cannot race', async () => {
  const { registered } = await mount(readyForm(ROUTE_PAIR), CATALOG, () => new Promise(() => {}))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )
  optionsOf(rendered.element).act.props.onClick()
  await rendered.rerender()
  assert.equal(triggerOf(rendered.element).props.disabled, true)
  // Reopening is refused while the commit is in flight.
  triggerOf(rendered.element).props.onClick()
  await rendered.rerender()
  assert.equal(menuOf(rendered.element), null)
})

// --- custom modes ---------------------------------------------------------

/** A route one custom mode is bound to; `so` it can be told apart from Plan/Act. */
const MODE_ROUTE = { provider: 'cline-pass', model: MODEL, reasoningEffort: 'low' }
/** The pair plus one custom mode, which is all the renderer needs to list it. */
const MODES_PAIR = { ...ROUTE_PAIR, modes: { m1: { name: '审查', ...MODE_ROUTE } } }
/** A committed selection sitting on that custom mode. */
const ON_MODE = { next: MODE_ROUTE, lastUsed: null }

test('a custom mode is a third entry in the same menu', async () => {
  const { registered } = await mount(readyForm(MODES_PAIR), CATALOG)
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )

  const rows = optionListOf(rendered.element)
  assert.deepEqual(
    rows.map((row) => row.props['data-mode-id']),
    ['plan', 'act', 'm1'],
    'custom modes follow the two built-ins, in their configured order',
  )
  // One accent per kind: Plan keeps blue, Act keeps green, and every
  // user-defined mode shares one tone so a long menu still reads as "mine".
  assert.deepEqual(rows.map((row) => row.props['data-tone']), ['plan', 'act', 'mode'])
  assert.match(textOf(rows[2]), /^审查：DeepSeek V4\.1 Flash$/)
})

test('the trigger shows the custom mode when the session sits on it', async () => {
  const { registered } = await mount(readyForm(MODES_PAIR), CATALOG)
  const rendered = await renderChip(registered, {
    sessionId: 's1',
    row: { cwd: 'C:/work' },
    plan: { active: false },
    selection: ON_MODE,
  })

  const trigger = triggerOf(rendered.element)
  assert.equal(trigger.props['data-tone'], 'mode')
  assert.match(textOf(trigger), /^审查：DeepSeek V4\.1 Flash$/)
  // The hover text still names the ids that cross the wire. It lives on the chip
  // frame rather than the button, so a failure line can share it.
  assert.match(
    chipOfElement(rendered.element).props.title,
    /cline-pass\/deepseek-v4\.1-flash-1017 \(low\) · 全局配置/,
  )
})

test('picking a custom mode commits its own route', async () => {
  const { registered, selected } = await mount(readyForm(MODES_PAIR), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )

  optionsOf(rendered.element).m1.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  // The same path a built-in pick takes: the Host's own selectModel, no private
  // event of our own, so the native selector and this menu cannot disagree.
  assert.deepEqual(selected, [{ sessionId: 's1', ...MODE_ROUTE }])
})

test('a custom mode with no name falls back to its position', async () => {
  const pair = { ...ROUTE_PAIR, modes: { m1: { name: '', ...MODE_ROUTE } } }
  const { registered } = await mount(readyForm(pair), CATALOG)
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )

  assert.match(textOf(optionsOf(rendered.element).m1), /^模式 1：DeepSeek V4\.1 Flash$/)
})

test('an incomplete custom mode stays visible but cannot be picked', async () => {
  const pair = { ...ROUTE_PAIR, modes: { m1: { name: '待补', provider: 'cline-pass', model: '' } } }
  const { registered, selected } = await mount(readyForm(pair), CATALOG, () => ({ ok: true, value: {} }))
  const rendered = await openChip(
    await renderChip(registered, {
      sessionId: 's1',
      row: { cwd: 'C:/work' },
      plan: { active: true },
      selection: ON_PLAN,
    }),
  )

  const row = optionsOf(rendered.element).m1
  assert.match(textOf(row), /^待补：未配置$/)
  assert.equal(row.props.disabled, true)
  row.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(selected, [], 'an entry the Host could not serve must not be committed')
})

// --- the settings page's custom-mode editor ------------------------------

test('the settings page lists every custom mode as its own card', async () => {
  const settings = await settingsOf({
    ...ROUTE_PAIR,
    modes: {
      m1: { name: '审查', ...MODE_ROUTE },
      m2: { name: '写文档', provider: 'cline-pass', model: MODEL },
    },
  })

  assert.deepEqual(
    modeCardsOf(settings.element).map((card) => card.props['data-mode-id']),
    ['m1', 'm2'],
    'cards follow the stored order',
  )
  const names = inputsOf(settings.element).filter((input) => input.props['aria-label'] === '模式名称')
  assert.deepEqual(names.map((input) => input.props.value), ['审查', '写文档'])
})

test('a mode with a cleared name is saved under its positional default', async () => {
  const settings = await settingsOf({ ...ROUTE_PAIR, modes: { m1: { name: '审查', ...MODE_ROUTE } } })
  const name = inputsOf(settings.element).find((input) => input.props['aria-label'] === '模式名称')
  name.props.onChange({ target: { value: '   ' } })
  await settings.rerender()
  clickButton(settings.element, '保存')
  await new Promise((resolve) => setTimeout(resolve, 0))

  // A stored blank name would make the Host invent one at render time; the page
  // writes the same default the Host would have, so both agree on the label.
  assert.deepEqual(savedValue(settings.writes).modes, { m1: { name: '模式 1', ...MODE_ROUTE } })
})

test('the add button appends a mode with the next id and a default name', async () => {
  const settings = await settingsOf(ROUTE_PAIR)
  assert.equal(modeCardsOf(settings.element).length, 0)

  clickButton(settings.element, '添加自定义模式')
  await settings.rerender()

  assert.deepEqual(
    modeCardsOf(settings.element).map((card) => card.props['data-mode-id']),
    ['m1'],
  )
  const name = inputsOf(settings.element).find((input) => input.props['aria-label'] === '模式名称')
  assert.equal(name.props.value, '模式 1')
  // A brand-new mode has no route yet, so the page refuses to save it and names
  // it — the same rule the two built-in tracks follow.
  assert.match(settings.text, /自定义模式「模式 1」的路由 需要同时选择 provider 与 model/)
})

test('a mode can be removed again', async () => {
  const settings = await settingsOf({
    ...ROUTE_PAIR,
    modes: { m1: { name: '审查', ...MODE_ROUTE }, m2: { name: '写文档', ...MODE_ROUTE } },
  })

  clickButton(modeCardsOf(settings.element)[0], '移除')
  await settings.rerender()

  assert.deepEqual(
    modeCardsOf(settings.element).map((card) => card.props['data-mode-id']),
    ['m2'],
    'removing a card drops only that mode',
  )
})

test('the page refuses a thirteenth custom mode', async () => {
  const modes = {}
  for (let n = 1; n <= 12; n += 1) modes[`m${n}`] = { name: `模式 ${n}`, ...MODE_ROUTE }
  const settings = await settingsOf({ ...ROUTE_PAIR, modes })

  assert.equal(modeCardsOf(settings.element).length, 12)
  assert.match(settings.text, /已达到上限 12 个/)
  const add = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node !== 'object') return
    if (node.type === 'button' && textOf(node) === '添加自定义模式') add.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(settings.element)
  assert.equal(add.length, 1)
  assert.equal(add[0].props.disabled, true)
})

test('the page no longer offers the project-override editor', async () => {
  const settings = await settingsOf({
    ...ROUTE_PAIR,
    projects: { 'C:/work': { mode: 'override', plan: MODE_ROUTE, act: MODE_ROUTE } },
  })

  // Hidden, not deleted: the Host still resolves `projects` and the other suites
  // still cover it, but a dropdown whose meaning depended on the folder was more
  // confusing than useful. Flip `SHOW_PROJECT_OVERRIDES` to bring the editor back.
  assert.doesNotMatch(settings.text, /项目覆盖/)
  assert.doesNotMatch(settings.text, /工作区绝对路径/)
})

test('a hand-written project override neither blocks nor is erased by a save', async () => {
  const override = { 'C:/work': { mode: 'override', plan: { provider: 'p', model: '' }, act: MODE_ROUTE } }
  const settings = await settingsOf({ ...ROUTE_PAIR, projects: override })

  clickButton(settings.element, '保存')
  await new Promise((resolve) => setTimeout(resolve, 0))

  // The override is incomplete, but this page cannot show it — so it must not
  // refuse to save, and it must round-trip the field untouched rather than
  // silently erasing configuration that was written by hand.
  assert.deepEqual(savedValue(settings.writes).projects, override)
})
