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

/** The composer control only: the settings page keeps its own native `<select>`s. */
const chipSource = source.slice(source.indexOf('function RouteSelect('))

/** Drop `//` and block-comment lines so prose cannot satisfy a token assertion. */
function code(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

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

test('the composer chip is not a native <select>', () => {
  // The platform popup of a `<select>` cannot be styled, which is what made the
  // previous version look like a stray OS widget in the composer. The chip is a
  // button plus a hand-rolled listbox, so the popup is ours to paint — but the
  // keyboard duty a `<select>` gave for free now has to be written out.
  assert.doesNotMatch(chipSource, /createElement\(\s*'select'/, 'the chip renders no <select>')
  assert.doesNotMatch(chipSource, /'aria-haspopup': 'menu'/, 'a listbox, not a menu')
  assert.match(chipSource, /className: 'pam-trigger'/)
  assert.match(chipSource, /className: 'pam-menu'/)
  assert.match(chipSource, /className: 'pam-option'/)
  assert.match(chipSource, /'aria-label': label/)
  assert.match(chipSource, /role: 'listbox'/)
  assert.match(chipSource, /role: 'option'/)
  assert.match(chipSource, /'aria-haspopup': 'listbox'/)
  assert.match(chipSource, /'aria-expanded'/)
  // Keyboard: open, walk, commit, dismiss.
  assert.match(chipSource, /event\.key === 'ArrowDown'/)
  assert.match(chipSource, /event\.key === 'ArrowUp'/)
  assert.match(chipSource, /event\.key === 'Escape'/)
  assert.match(chipSource, /event\.key === 'Enter'/)
  // The mode word carries the accent colour; both tokens must stay named so a
  // theme change repaints the chip instead of leaving a hardcoded blue.
  assert.match(source, /--dsw-alias-state-business-primary/, 'Plan keeps the business accent')
  assert.match(source, /--dsw-alias-state-success-primary/, 'Act keeps the success accent')
})

test('the chip stylesheet is injected from the factory, not the module top level', () => {
  // `client-modules` claims the `<style>` tags a *factory* added; a top-level
  // side effect runs at script arrival and is reported as an early effect.
  assert.match(source, /const CHIP_STYLE_ID = 'dsh-plan-act-models\/chip\.css'/)
  assert.match(source, /function ensureChipStyles\(\)/)
  assert.match(source, /tag\.dataset\.plugin = 'dsh-plan-act-models'/)
  assert.match(source, /tag\.dataset\.pluginCss = CHIP_STYLE_ID/)
  assert.match(source, /style\[data-plugin-css=/)
  const apply = source.slice(source.indexOf('apply(ctx) {'))
  assert.match(apply, /^\s*ensureChipStyles\(\)$/m, 'apply() must install the stylesheet')
  assert.doesNotMatch(
    source.slice(0, source.indexOf('const CHIP_CSS')),
    /ensureChipStyles\(\)/,
    'nothing may call it before the factory body runs',
  )
})

test('the chip uses only tokens the Host actually defines', () => {
  // These were invented, never existed in `design-platform.css`, and so always
  // fell back to grey: the settings page wore a dirty border for it.
  const body = code(source)
  for (const missing of [
    '--dsw-alias-border,',
    '--dsw-alias-border-radius',
    '--dsw-alias-bg-secondary',
    '--dsw-alias-text-secondary',
    '--dsw-alias-text-danger',
    '--dsw-alias-label-danger',
    '--dsw-composer-model-text-display',
  ]) {
    assert.equal(body.includes(missing), false, `${missing} is not a Host token`)
  }
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
