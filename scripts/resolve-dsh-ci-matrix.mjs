import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildDshCiMatrix } from './dsh-matrix-lib.mjs'

const config = JSON.parse(await readFile(resolve(process.argv[2] ?? 'compatibility/dsh-matrix.json'), 'utf8'))
const response = await fetch('https://registry.npmjs.org/%40deepseek-ai%2Fdsh', { signal: AbortSignal.timeout(20_000) })
if (!response.ok) throw new Error(`npm-registry-unavailable:${response.status}`)
const metadata = await response.json()
const forcedCandidate = process.env.DSH_CANDIDATE_VERSION?.trim() ?? ''
if (forcedCandidate !== '' && !Object.prototype.hasOwnProperty.call(metadata.versions ?? {}, forcedCandidate)) {
  process.stderr.write(`candidate-version-not-published:${forcedCandidate}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify(buildDshCiMatrix(config, metadata['dist-tags'] ?? {}, { forcedCandidate })))
}
