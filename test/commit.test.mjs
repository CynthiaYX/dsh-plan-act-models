/**
 * Rule tests for `tools/commit-check.mjs`.
 *
 * The checker is pure, so every rule is driven here with literal messages. The
 * point of the suite is that a rule cannot be loosened later without a test
 * failing: the repository's history is small enough that the convention only
 * survives if it is enforced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { BODY_MAX, BODY_LINES_SOFT, SUBJECT_MAX, TYPES, check, decode } from '../tools/commit-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'tools', 'commit-check.mjs')

test('a conventional message passes with no errors', () => {
  const { errors, warnings } = check('feat(view): show the route chip\n')
  assert.deepEqual(errors, [])
  assert.deepEqual(warnings, [])
})

test('a scoped subject and a short body pass', () => {
  const message = [
    'fix(routing): reuse the Act route',
    '',
    'The state only flips on transition.',
    'The next request still read the old route.',
  ].join('\n')
  assert.deepEqual(check(message).errors, [])
})

test('every documented type is accepted', () => {
  for (const type of TYPES) {
    const { errors } = check(`${type}: a change`)
    assert.deepEqual(errors, [], `${type} must be accepted`)
  }
})

test('an unknown type is rejected', () => {
  const { errors } = check('feature(client): a change')
  assert.match(errors.join('\n'), /unknown type "feature"/)
})

test('a subject without a type prefix is rejected', () => {
  const { errors } = check('Show the route beside the selector')
  assert.match(errors.join('\n'), /type\(scope\): summary/)
})

test('a subject ending with a period is rejected', () => {
  assert.match(check('docs: update the readme.').errors.join('\n'), /must not end with a period/)
  assert.match(check('docs: 更新说明。').errors.join('\n'), /must not end with a period/)
})

test('an over-long subject is rejected, counted in characters', () => {
  const ascii = `docs: ${'a'.repeat(SUBJECT_MAX)}`
  assert.match(check(ascii).errors.join('\n'), /keep it at or under/)
  // Chinese characters are one character each, even though they are 3 bytes.
  const cjk = `docs: ${'中'.repeat(SUBJECT_MAX - 6)}`
  assert.deepEqual(check(cjk).errors, [])
})

test('an empty message is rejected', () => {
  assert.match(check('').errors.join('\n'), /empty/)
  assert.match(check('\n\n  \n').errors.join('\n'), /empty/)
})

test('a body glued to the subject is rejected', () => {
  const { errors } = check('feat: a change\nbecause reasons')
  assert.match(errors.join('\n'), /blank line between the subject and the body/)
})

test('a body line wider than the limit is rejected', () => {
  const message = `feat: a change\n\n${'x'.repeat(BODY_MAX + 1)}`
  assert.match(check(message).errors.join('\n'), /wrap at/)
})

test('a long body warns without blocking', () => {
  const body = Array.from({ length: BODY_LINES_SOFT + 1 }, (_, index) => `line ${index}`)
  const { errors, warnings } = check(['feat: a change', '', ...body].join('\n'))
  assert.deepEqual(errors, [])
  assert.match(warnings.join('\n'), /usually says enough/)
})

test('comment lines from the template are ignored', () => {
  const message = ['feat: a change', '', '# a comment that is far too long '.repeat(8)].join('\n')
  assert.deepEqual(check(message).errors, [])
})

test('generated merge and revert subjects are let through', () => {
  assert.deepEqual(check('Merge branch \'main\' into feature/logins').errors, [])
  assert.deepEqual(check('Revert "feat: show the route beside the selector"').errors, [])
})

test('attribution lines are rejected', () => {
  const withGeneration = ['feat: a change', '', 'Generated with Claude Code'].join('\n')
  assert.match(check(withGeneration).errors.join('\n'), /drop the attribution/)
  const withRobot = ['feat: a change', '', '🤖 a note'].join('\n')
  assert.match(check(withRobot).errors.join('\n'), /drop the attribution/)
})

test('CRLF input from a Windows editor is accepted', () => {
  const message = ['feat: a change', '', 'because reasons'].join('\r\n')
  assert.deepEqual(check(message).errors, [])
})

test('UTF-16 and BOM-prefixed files decode before they are judged', () => {
  const text = 'feat: 显示路由标签'

  // PowerShell's `>` writes UTF-16LE with a BOM; reading that as UTF-8 makes
  // every other byte a NUL and turns the subject into garbage.
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.equal(decode(le), text)

  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])
  assert.equal(decode(be), text)

  const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
  assert.equal(decode(bom8), text)

  assert.equal(decode(Buffer.from(text, 'utf8')), text)
  assert.deepEqual(check(decode(le)).errors, [])
})

test('the CLI exits non-zero on a bad message and zero on a good one', () => {
  const run = (args) =>
    execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe' })

  assert.throws(
    () => run(['--message', 'no type here']),
    (error) => error.status === 1 && /error: subject must read/.test(error.stderr),
  )
  assert.doesNotThrow(() => run(['--message', 'chore: a change']))
})
