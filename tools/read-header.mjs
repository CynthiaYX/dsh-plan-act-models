/**
 * Print every `request/header` recorded in a DSH session log.
 *
 * Session logs are multi-frame zstd: `zlib.zstdDecompressSync` decodes only the
 * FIRST frame, which is just the 244-byte session header. Each frame has to be
 * split on the zstd magic and decompressed on its own.
 *
 * Usage:
 *   node tools/read-header.mjs "<path to session.v4.jsonl.zstd>"
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every zstd frame in one archive buffer.
 * @param buffer - raw archive bytes.
 * @returns the concatenated JSONL text.
 */
function decodeFrames(buffer) {
  const starts = []
  for (let at = buffer.indexOf(MAGIC); at !== -1; at = buffer.indexOf(MAGIC, at + 1)) {
    starts.push(at)
  }
  if (starts.length === 0) return buffer.toString('utf8')

  const chunks = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8'))
    } catch (error) {
      // A truncated trailing frame is normal for a live session.
      if (index + 1 < starts.length) throw error
    }
  }
  return chunks.join('')
}

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/read-header.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

const text = decodeFrames(readFileSync(file))
const rows = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    continue
  }
  if (entry.type === 'request/header') rows.push(entry)
  if (entry.type === 'plan/mode') {
    console.log(`plan/mode   seq ${entry.seq}: ${JSON.stringify(entry.data)}`)
  }
}

if (rows.length === 0) {
  console.log('no request/header entries found')
} else {
  for (const row of rows) {
    const config = row.data?.header?.config ?? {}
    const defaults = row.data?.header?.adapterDefaults ?? {}
    console.log(
      `seq ${String(row.seq).padStart(4)}  `
      + `${config.provider}/${config.model}  `
      + `effort=${config.reasoningEffort ?? '(none)'}  `
      + `maxTokens=${config.maxTokens ?? '(none)'}  `
      + `adapterDefaults=${JSON.stringify(defaults)}`,
    )
  }
}
