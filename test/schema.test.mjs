import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { loadSchema } from '../lib/schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The resolution walk is environment-sensitive by design: it succeeds inside a
 * packaged Host and may fail on this repository. Every assertion below
 * distinguishes "resolved something usable" from "reported a complete
 * failure", never from "did not throw".
 */
async function resolveOrReport() {
  try {
    return { schema: await loadSchema() }
  } catch (error) {
    return { error }
  }
}

test('loadSchema resolves a usable namespace or reports every path it tried', async () => {
  const { schema, error } = await resolveOrReport()
  if (error) {
    // A machine without a usable copy still gets an actionable message listing
    // each rejected candidate — including a stale copy, by version.
    assert.match(error.message, /\[plan-act-models\] 找不到可用的 @deepseek-ai\/schemastery/)
    assert.match(error.message, /3\.18\.5/)
    assert.match(error.message, /DSH_SCHEMASTER_ROOT/)
    return
  }
  for (const name of ['object', 'dict', 'string', 'boolean', 'union', 'const']) {
    assert.equal(typeof schema[name], 'function', `schemastery is missing ${name}()`)
  }
})

test('a resolved namespace is new enough to declare volatile fields', async () => {
  const { schema: z, error } = await resolveOrReport()
  if (error) return
  // The one capability index.js depends on that older copies lack entirely.
  assert.equal(typeof z.boolean().volatile, 'function')
  assert.equal(z.boolean().default(false).volatile().meta.volatile, true)
})

test('the resolved namespace builds the schema shapes index.js declares', async () => {
  const { schema: z, error } = await resolveOrReport()
  if (error) return
  const Route = z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  })
  const ProjectEntry = z.object({
    mode: z.union(['inherit', 'override', 'off']).default('inherit'),
    plan: Route.default({}),
    act: Route.default({}),
  })
  const Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    plan: Route.volatile(),
    act: Route.volatile(),
    projects: z.dict(ProjectEntry).default({}).volatile(),
  })

  const config = Config({})
  assert.equal(config.enabled.get(), false)
  assert.deepEqual(config.plan.get(), { provider: '', model: '', reasoningEffort: '' })
  assert.deepEqual(config.projects.get(), {})

  // The union is what rejects a hand-edited project entry.
  assert.throws(
    () => Config({ projects: { 'c:/w': { mode: 'bogus' } } }),
    /expected "inherit" \| "override" \| "off"/,
  )
})

test('DSH_SCHEMASTER_ROOT is honoured but never trusted blindly', async () => {
  const previous = process.env.DSH_SCHEMASTER_ROOT
  try {
    process.env.DSH_SCHEMASTER_ROOT = join(here, 'definitely-not-schemastery')
    const { schema, error } = await resolveOrReport()
    // A bogus override must fall through to the remaining candidates instead of
    // short-circuiting the whole lookup into a hard failure.
    if (error) assert.match(error.message, /找不到可用的 @deepseek-ai\/schemastery/)
    else assert.equal(typeof schema.object, 'function')
  } finally {
    if (previous === undefined) delete process.env.DSH_SCHEMASTER_ROOT
    else process.env.DSH_SCHEMASTER_ROOT = previous
  }
})

test('a stale copy without .volatile() is rejected instead of silently used', () => {
  // Guard the guard: the check has to be a capability test, because a 3.18.1
  // copy resolves fine and only explodes later, inside the Config declaration.
  const source = readFileSync(join(here, '..', 'lib', 'schema.mjs'), 'utf8')
  assert.match(source, /typeof candidate\.object\(\{\}\)\.volatile === 'function'/)
  assert.match(source, /缺少 \.volatile\(\)/)
})

test('schema.mjs declares no top-level dependency on the Host install', () => {
  const source = readFileSync(join(here, '..', 'lib', 'schema.mjs'), 'utf8')
  // The bare import has to stay inside a function so that a missing install
  // surfaces through fromDisk()'s diagnostic instead of as a load-time crash.
  const bare = source.indexOf("import('@deepseek-ai/schemastery')")
  assert.notEqual(bare, -1, 'the bare import moved or was removed')
  const start = source.indexOf('async function bareImport')
  assert.ok(start !== -1 && bare > start, 'the bare import must remain inside bareImport()')
  assert.doesNotMatch(source, /^import .*@deepseek-ai\/schemastery/m)
})
