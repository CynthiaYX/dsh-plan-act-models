/**
 * Static assertions about `client.js`.
 *
 * The bundle cannot be imported as a module (it registers through
 * `window.__ModuleLoader__`), so the behavioural half lives in
 * `test/client-bundle.test.mjs`. This file pins the things that would be easy to
 * delete by accident and whose absence the runtime tests might not notice: the
 * Loader row id agreement, the mirror sentinels, and the fact that a pick goes
 * through the Host's `session.selectModel` rather than an event of our own.
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
  // then made that project's entries unselectable at runtime.
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

test('the bundle registers the mode dropdown beside the model selector', () => {
  // `conversation.input.right` is rendered immediately before
  // `conversation.input.model` in the Host's `InputBar`, so registering there is
  // the only way to land on the left of the native selector without patching it.
  assert.match(source, /name: 'conversation\.input\.right'/)
  assert.match(source, /const CHIP_ID = 'plan-act-route'/)
  assert.match(source, /id: CHIP_ID/)
  assert.match(source, /function RouteSelect\(/)
  assert.match(source, /ctx\.slots\.inject\('conversation\.input\.right'/)
})

test('the dropdown is a real <select>, not a decorative label', () => {
  // The whole point of the change: the old component rendered a `<span>` that
  // only described the route. A `<select>` gives keyboard operation and an
  // accessible name for free, and matches the settings page.
  assert.match(source, /React\.createElement\(\s*'select'/)
  assert.match(source, /'aria-label': label/)
  assert.match(source, /onChange: \(event\) => \{/)
  assert.match(source, /'option'/)
})

test('choosing an entry commits through the Host’s own session.selectModel', () => {
  // Not an event of our own: `selectModel` validates the route, updates the
  // `modelSelection` projection every client reads, and writes the pick into the
  // session log — so the dropdown and the native selector cannot disagree.
  assert.match(source, /remote\.session\.selectModel\(request\)/)
  assert.match(source, /inject: \['slots', 'configForms', 'remote', 'remote\.session'\]/)
  assert.match(source, /code: 'NO_REMOTE'/)
})

test('the route payload omits an empty effort instead of sending one', () => {
  assert.match(source, /\.\.\.route\.reasoningEffort === undefined \? \{\} : \{ reasoningEffort: route\.reasoningEffort \}/)
})

test('the control carries a mirror of resolveTarget and sessionTrack in a testable region', () => {
  // The bundle cannot import `lib/routing.mjs`, so both tables are duplicated.
  // `test/client-view.test.mjs` extracts this exact region and compares them with
  // the real functions; losing a sentinel there would silently weaken the
  // comparison, so both are asserted here too.
  assert.match(source, /\/\/ #region plan-act-view/)
  assert.match(source, /\/\/ #endregion plan-act-view/)
  assert.match(source, /function mirrorResolve\(config, path, mode\)/)
  assert.match(source, /function mirrorTrackOf\(selection, config, path, mode\)/)
  assert.match(source, /function mirrorSameTrack\(selection, wanted\)/)
  assert.match(source, /function routeLabel\(track, resolved, catalog\)/)
  assert.match(source, /function customLabel\(selection, catalog\)/)
  assert.match(source, /const LABEL_SEPARATOR = '：'/)
})

test('the retired wording is gone', () => {
  // `Act：已关闭` claimed the entry itself was dead when the switch was off; it is
  // not — only the automatic rule stops. The title still says `自动切换已关闭`,
  // which is why this matches the labelled form rather than the bare word.
  assert.doesNotMatch(source, /：已关闭/)
  assert.doesNotMatch(source, /功能已关闭/)
  assert.doesNotMatch(source, /function RouteChip\(/)
})

test('the settings page never binds a locale, so the locale files are unused', () => {
  // Documented limitation: `locale/*.json` carry only a title/description and the
  // page hardcodes its strings. If that ever changes, this test should change.
  assert.equal(/locale/i.test(source), false)
})
