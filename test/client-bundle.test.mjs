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
 * (`configForms`, `slots`) and asserts what the real code asks for. It also
 * pins the invariant that matters most: the namespace handed to
 * `configForms.get()` must equal the `id` in `cordis.patch.yml`, because
 * `dsh-settings` keys `describe()` by the Loader row id.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * A React stand-in: the factory destructures these four hooks and calls
 * `createElement` while rendering, and `apply()` renders nothing.
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
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

test('the bundle declares the package id and its Services', async () => {
  const declaration = await loadDeclaration()
  assert.equal(declaration.id, 'dsh-plan-act-models')
  assert.equal(typeof declaration.factory, 'function')
})

test('apply() asks the Host for the namespace cordis.patch.yml declares', async () => {
  const declaration = await loadDeclaration()
  const module = declaration.factory((specifier) => {
    assert.equal(specifier, 'react', 'the bundle must only require react')
    return fakeReact()
  })

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const rowId = patch.match(/^\s*- id: (\S+)$/m)?.[1]
  assert.ok(rowId, 'cordis.patch.yml must declare an insert row id')

  const asked = []
  const registered = []
  const ctx = {
    configForms: {
      get(namespace) {
        asked.push(namespace)
        return { getSnapshot: () => ({ status: 'loading' }) }
      },
    },
    slots: {
      inject(seat, callback) {
        assert.equal(seat, 'settings.section')
        callback()
        return () => {}
      },
      register(spec) {
        registered.push(spec)
        return () => {}
      },
    },
    remote: {},
  }

  module.apply(ctx)

  assert.deepEqual(asked, [rowId], 'configForms.get() must use the Loader row id')
  assert.equal(registered.length, 1, 'exactly one settings page')
  assert.equal(registered[0].name, 'settings.section')
  assert.equal(registered[0].id, rowId)
  assert.equal(typeof registered[0].label, 'function')
  assert.match(registered[0].label(), /Plan \/ Act/)
})
