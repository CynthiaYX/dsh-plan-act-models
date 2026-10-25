/**
 * Locate `@deepseek-ai/schemastery` for the Host.
 *
 * The Harness answers a bare import from its installation scope — the running
 * Host resolves packages carried by the dsh installation for every module in
 * the process — so the plain import is the normal path. The fallback covers the
 * packaged Desktop layout, where our bundle is a link and the only copy on disk
 * lives inside `app.asar`: Electron's fs shims read the archive, and a plain
 * `node` process simply fails that attempt and reports what it tried.
 *
 * Two things make that fallback fragile, so both are handled explicitly:
 *
 * 1. We do not control `process.execPath`. Under the Desktop app it is
 *    `DeepSeek Harness.exe` and one `..` reaches `resources/app.asar`; under a
 *    CLI host it is the bundled `node.exe` inside
 *    `resources/runtime/primary-runtime/dependencies/node/bin`, four levels
 *    deeper. The walk therefore climbs further and also derives candidates from
 *    the launched script's own location instead of assuming either shape.
 * 2. An unpacked install may carry the package outside the archive. Both
 *    `app.asar` and `app.asar.unpacked` are probed, plus `DSH_SCHEMASTER_ROOT`
 *    for a caller that wants to name the copy outright.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** How far above a launching binary we are willing to look for `resources`. */
const ARCHIVE_DEPTH = 8

const PACKAGE_TAIL = ['node_modules', '@deepseek-ai', 'schemastery', 'package.json']

async function bareImport() {
  const mod = await import('@deepseek-ai/schemastery')
  return mod.default ?? mod
}

function profileRoots() {
  const roots = []
  if (process.env.DSH_PROFILE_DIR) roots.push(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const name of [process.env.DSH_PROFILE, 'desktop', 'default']) {
    if (name) roots.push(join(home, 'profiles', name))
  }
  return roots.filter((root, index) => roots.indexOf(root) === index)
}

/**
 * Manifests named outright by `DSH_SCHEMASTER_ROOT`: either the package
 * directory itself, a `package.json`, or a directory that contains the package
 * as `<root>/node_modules/@deepseek-ai/schemastery`.
 * @returns manifest paths to try with `createRequire`.
 */
function explicitManifests() {
  const configured = process.env.DSH_SCHEMASTER_ROOT
  if (!configured || configured.trim() === '') return []
  const base = resolve(configured.trim())
  if (base.endsWith('.json')) return [base]
  return [join(base, 'package.json'), join(base, ...PACKAGE_TAIL)]
}

/**
 * The archives a packaged Desktop installation may carry, nearest first: the
 * application executable sits next to its `resources` directory, and the
 * bundled Node binary sits inside it.
 * @param {string} start directory to climb from
 * @returns manifest paths to try with `createRequire`.
 */
function archiveManifests(start) {
  const manifests = []
  const seen = new Set()
  let current = start
  for (let depth = 0; depth < ARCHIVE_DEPTH; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    for (const archive of ['app.asar', 'app.asar.unpacked']) {
      manifests.push(join(current, 'resources', archive, 'dsh', ...PACKAGE_TAIL))
    }
    // A host launched straight out of a checkout or an unpacked install keeps
    // the package in an ordinary node_modules next to the script.
    manifests.push(join(current, ...PACKAGE_TAIL))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return manifests
}

/**
 * Directories worth climbing from: the executable, and every path the Host was
 * launched with (the dsh install root is passed to the Host as an argument).
 * @returns {string[]} absolute directories, nearest-looking first
 */
function launchRoots() {
  const roots = [dirname(resolve(process.execPath))]
  for (const argument of process.argv.slice(1)) {
    if (typeof argument !== 'string' || !isAbsolute(argument)) continue
    if (!existsSync(argument)) continue
    // argv[1] may be the Host script itself; climb from its directory.
    roots.push(argument.endsWith('.js') || argument.endsWith('.mjs') ? dirname(argument) : argument)
  }
  return roots.filter((root, index) => roots.indexOf(root) === index)
}

/** The API this plugin actually calls; anything older is unusable. */
const REQUIRED = ['object', 'dict', 'string', 'boolean', 'union', 'const']

/**
 * Whether `candidate` is a schemastery new enough for this plugin.
 *
 * The version matters, not just the presence of a package: `.volatile()` was
 * added in 3.18.5, and an older copy resolves happily but has no such method,
 * so the schema declarations in `index.js` would throw at load time. A stale
 * copy in an ancestor `node_modules` is exactly what a linked install runs into.
 * @param {any} candidate the module namespace or its default export
 * @returns {boolean}
 */
function usable(candidate) {
  if (candidate === undefined || candidate === null) return false
  return REQUIRED.every((name) => typeof candidate[name] === 'function')
    && typeof candidate.object({}).volatile === 'function'
}

/** @param {any} mod a loaded module namespace */
function unwrap(mod) {
  return mod?.default ?? mod
}

function fromDisk() {
  const failures = []
  // The Host's own packaged copy comes BEFORE any profile-level one: it is the
  // build whose `.volatile()` semantics match what the Host's settings service
  // expects, and an ancestor `node_modules` can easily hold a stale copy (a
  // leftover junction, an npx cache) that resolves but lacks the method.
  const candidates = [
    ...explicitManifests(),
    ...launchRoots().flatMap(archiveManifests),
    ...profileRoots().map((root) => join(root, 'package.json')),
  ].filter((manifest, index, all) => all.indexOf(manifest) === index)
  for (const manifest of candidates) {
    if (!existsSync(dirname(manifest))) continue
    const require = createRequire(manifest)
    let resolved
    try {
      resolved = require.resolve('@deepseek-ai/schemastery')
    } catch (error) {
      failures.push(`${dirname(manifest)}: ${error.code ?? error.message}`)
      continue
    }
    try {
      const candidate = unwrap(require('@deepseek-ai/schemastery'))
      if (!usable(candidate)) {
        const version = readVersion(resolved)
        failures.push(`${dirname(manifest)}: ${version ?? '未知版本'} 缺少 .volatile()（需要 ≥ 3.18.5）`)
        continue
      }
      return candidate
    } catch (error) {
      failures.push(`${dirname(manifest)}: ${error.code ?? error.message}`)
    }
  }
  const tried = failures.length === 0 ? '（本机没有可用的副本）' : failures.join('; ')
  throw new Error(
    `[plan-act-models] 找不到可用的 @deepseek-ai/schemastery（需要 ≥ 3.18.5，带 .volatile()），`
      + `已尝试裸 import 与 ${tried}；可用环境变量 DSH_SCHEMASTER_ROOT 指向该包所在目录`,
  )
}

/**
 * Best-effort version of the package a resolution landed on, for diagnostics.
 * @param {string} entry the resolved main file
 * @returns {string|undefined}
 */
function readVersion(entry) {
  let current = dirname(entry)
  for (let depth = 0; depth < 3; depth += 1) {
    const manifest = join(current, 'package.json')
    try {
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed.name === '@deepseek-ai/schemastery') return parsed.version
      }
    } catch {
      // A malformed neighbour is not a reason to abort the search.
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Resolve the schema helper, preferring the running Host's own resolution.
 * @returns the schemastery namespace (`z.object`, `z.dict`, `z.string`, …).
 */
export async function loadSchema() {
  try {
    const candidate = unwrap(await bareImport())
    if (usable(candidate)) return candidate
  } catch {
    // Fall through: the installation-scope copy is missing or unusable.
  }
  return fromDisk()
}

