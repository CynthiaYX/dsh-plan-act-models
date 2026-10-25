/**
 * Validation tests for the settings page's `routeError` table.
 *
 * `client.js` is a `window.__ModuleLoader__` bundle, so the whole file cannot be
 * imported. The validation rule it applies is duplicated here from the source,
 * and `client.test.mjs` separately asserts the bundle registers correctly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('the settings page validates every project override, not just the global pair', () => {
  // Regression guard: the validation used to cover only `draft.plan`/`draft.act`,
  // so an enabled config with an incomplete `override` project saved cleanly and
  // then blocked every request in that project at runtime.
  assert.match(
    source,
    /for \(const \[key, entry\] of Object\.entries\(draft\.projects \?\? \{\}\)\)/,
    'validation must iterate project overrides',
  )
  assert.match(source, /entry\?\.mode !== 'override'/)
  assert.match(source, /项目「\$\{key\}」的 Plan 路由/)
  assert.match(source, /项目「\$\{key\}」的 Act 路由/)
})

test('the bundle registers exactly one settings section under the Loader row id', () => {
  assert.match(source, /id: 'dsh-plan-act-models'/)
  assert.match(source, /const ENTRY = 'plan-act-models'/)
  assert.match(source, /name: 'settings\.section'/)
  assert.match(source, /ctx\.slots\.register\(/)
})

test('ENTRY matches the Loader row id the bundle ships in cordis.patch.yml', () => {
  // Regression guard: `dsh-settings` keys its namespace by `entry.options.id`
  // (the Loader row id), and the page reads its form through `configForms.get(id)`.
  // If the two drift apart the page renders "宿主没有提供配置项「…」" forever,
  // because the Host never serves the namespace the page asks for.
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  const declared = patch.match(/^\s*- id: (\S+)$/m)
  assert.ok(declared, 'cordis.patch.yml must declare an insert row id')
  const entry = source.match(/const ENTRY = '([^']+)'/)
  assert.ok(entry, 'client.js must declare ENTRY')
  assert.equal(entry[1], declared[1])
})

test('the bundle also registers the composer chip beside the model selector', () => {
  // `conversation.input.right` is rendered immediately before
  // `conversation.input.model` in the Host's `InputBar`, so registering there is
  // the only way to land on the left of the native selector without patching it.
  assert.match(source, /name: 'conversation\.input\.right'/)
  assert.match(source, /const CHIP_ID = 'plan-act-route'/)
  assert.match(source, /id: CHIP_ID/)
  assert.match(source, /function RouteChip\(/)
  assert.match(source, /ctx\.slots\.inject\('conversation\.input\.right'/)
})

test('the chip carries a mirror of resolveTarget inside a testable region', () => {
  // The bundle cannot import `lib/routing.mjs`, so the decision table is
  // duplicated. `test/client-view.test.mjs` extracts this exact region and
  // compares it with the real `resolveTarget`; losing a sentinel there would
  // silently weaken the comparison, so both are asserted here too.
  assert.match(source, /\/\/ #region plan-act-view/)
  assert.match(source, /\/\/ #endregion plan-act-view/)
  assert.match(source, /function mirrorResolve\(config, path, mode\)/)
  assert.match(source, /function routeLabel\(mode, resolved, catalog, enabled\)/)
  assert.match(source, /const LABEL_SEPARATOR = '：'/)
})

test('the settings page never binds a locale, so the locale files are unused', () => {
  // Documented limitation: `locale/*.json` carry only a title/description and the
  // page hardcodes its strings. If that ever changes, this test should change.
  assert.equal(/locale/i.test(source), false)
})
