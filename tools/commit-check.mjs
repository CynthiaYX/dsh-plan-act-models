/**
 * Validate a commit message against this repository's convention.
 *
 * The rules are deliberately few, because the only one that has ever caused
 * trouble here is a message that says too much: the subject carries the change,
 * the body explains the *why*, and anything else belongs in the diff.
 *
 * The module is pure so `test/commit.test.mjs` can drive it directly; the CLI at
 * the bottom is what `.githooks/commit-msg` calls.
 *
 * Usage:
 *   node tools/commit-check.mjs .git/COMMIT_EDITMSG   # what the hook does
 *   node tools/commit-check.mjs --stdin               # pipe a message in
 *   node tools/commit-check.mjs --message "docs: ..."  # check one string
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Types the subject may start with. `style` exists for whitespace-only diffs. */
export const TYPES = [
  'feat',
  'fix',
  'docs',
  'test',
  'refactor',
  'perf',
  'build',
  'ci',
  'chore',
  'revert',
  'style',
]

/**
 * Longest accepted subject, in characters (not bytes: subjects may be Chinese).
 *
 * This budget covers the whole `type(scope): summary` line, so a scope costs its
 * own characters. At this width `feat(view): ` is 12 of the 36 and leaves 24 for
 * the summary; the longest prefix in use, `refactor(routing): `, still leaves 17.
 */
export const SUBJECT_MAX = 36

/** Longest accepted body line. Wider than the subject so a full sentence fits;
 *  the body is a few facts, not prose. */
export const BODY_MAX = 50

/** Bodies longer than this are flagged as too long to read. */
export const BODY_LINES_SOFT = 3

/**
 * Messages git or the user generated rather than wrote: rewriting these would
 * only make `git revert` and autosquash output non-standard.
 */
const AUTO_SUBJECTS = [/^Merge /, /^Revert "/, /^(fixup|squash|amend)! /]

const SUBJECT_PATTERN = /^([a-z]+)(?:\(([a-z0-9./-]+)\))?(!)?: (.+)$/

/**
 * Attribution that no commit here should carry: the trailer is machine-readable
 * and says nothing about the change.
 */
const AI_MARKERS = [
  /generated with/i,
  /\bclaude code\b/i,
  /noreply@anthropic\.com/i,
  /^🤖/u,
]

/**
 * Check one message.
 * @param message - full commit message text.
 * @returns the errors that must block the commit and the non-blocking warnings.
 */
export function check(message) {
  const errors = []
  const warnings = []

  const lines = String(message ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    // `COMMIT_EDITMSG` still carries the template's `#` guidance when the hook
    // runs, and git only strips those lines later.
    .filter((line) => !line.startsWith('#'))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  if (lines.length === 0) {
    errors.push('the message is empty')
    return { errors, warnings }
  }

  const subject = lines[0]
  const body = lines.slice(1)
  const auto = AUTO_SUBJECTS.some((pattern) => pattern.test(subject))

  if (auto) {
    // A merge or revert subject is git's own wording; only the body is ours.
    if (Array.from(subject).length > SUBJECT_MAX + 40) {
      errors.push(`the generated subject is ${Array.from(subject).length} characters; shorten the branch name`)
    }
  } else {
    const match = SUBJECT_PATTERN.exec(subject)
    if (match === null) {
      errors.push(`subject must read "type(scope): summary", got "${subject}"`)
    } else {
      const [, type, scope] = match
      if (!TYPES.includes(type)) {
        errors.push(`unknown type "${type}"; use one of ${TYPES.join(', ')}`)
      }
      if (scope !== undefined && scope.includes('--')) {
        errors.push(`scope "${scope}" repeats a separator`)
      }
    }
    if (Array.from(subject).length > SUBJECT_MAX) {
      errors.push(
        `subject is ${Array.from(subject).length} characters; keep it at or under ${SUBJECT_MAX}`,
      )
    }
    if (/[.。]$/.test(subject)) errors.push('subject must not end with a period')
  }

  if (body.length > 0 && body[0].trim() !== '') {
    errors.push('leave one blank line between the subject and the body')
  }

  const bodyLines = body.filter((line) => line.trim() !== '')
  body.forEach((line, index) => {
    if (Array.from(line).length > BODY_MAX) {
      errors.push(`body line ${index + 2} is ${Array.from(line).length} characters; wrap at ${BODY_MAX}`)
    }
  })
  if (bodyLines.length > BODY_LINES_SOFT) {
    warnings.push(
      `the body is ${bodyLines.length} lines; ${BODY_LINES_SOFT} or fewer usually says enough`,
    )
  }

  for (const line of [subject, ...body]) {
    if (AI_MARKERS.some((pattern) => pattern.test(line))) {
      errors.push(`drop the attribution line "${line.trim().slice(0, 60)}"`)
      break
    }
  }

  return { errors, warnings }
}

/**
 * Decode a message buffer.
 *
 * Windows editors and PowerShell redirection happily write UTF-16 with a BOM,
 * and reading those bytes as UTF-8 produces a subject full of NUL characters and
 * a nonsense "unknown type" error. Detect the encoding from the BOM instead.
 * @param buffer - raw bytes of the message file.
 * @returns the decoded text, with any BOM removed.
 */
export function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  return buffer.toString('utf8')
}

/**
 * Read the message the CLI was pointed at.
 * @param argv - process arguments.
 * @returns the message text.
 */
function readMessage(argv) {
  const [first, second] = argv
  if (first === '--stdin') return decode(readFileSync(0))
  if (first === '--message') return second ?? ''
  if (first !== undefined) return decode(readFileSync(first))
  throw new Error('usage: commit-check.mjs <file> | --stdin | --message <text>')
}

function main(argv) {
  let message
  try {
    message = readMessage(argv)
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(2)
  }

  const { errors, warnings } = check(message)
  for (const warning of warnings) console.error(`warning: ${warning}`)
  for (const error of errors) console.error(`error: ${error}`)
  if (errors.length > 0) {
    console.error('\nThe format is documented in CONTRIBUTING.md.')
    process.exit(1)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main(process.argv.slice(2))
