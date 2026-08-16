import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { validateHubRelease } from './hub-release-lib.mjs'

const candidate = resolve(process.argv[2] ?? 'dist/hub/0.0.2-m0')
const evidencePath = resolve(process.argv[3] ?? 'evidence/m2-hub-release-compatibility-2026-08-17.json')
const tempRoot = await mkdtemp(join(tmpdir(), 'harness-flow-hub-release-contract-'))

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function expectReject(name, mutate, pattern) {
  const target = join(tempRoot, name)
  await cp(candidate, target, { recursive: true })
  await mutate(target)
  try {
    await validateHubRelease(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!pattern.test(message)) throw error
    return { name, rejected: true, reason: message }
  }
  throw new Error(`${name} unexpectedly passed`)
}

try {
  const valid = await validateHubRelease(candidate)
  const wrongTag = await (async () => {
    try {
      await validateHubRelease(candidate, { expectedVersion: '0.0.3' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/tag version mismatch/.test(message)) throw error
      return { name: 'wrong-tag-version', rejected: true, reason: message }
    }
    throw new Error('wrong-tag-version unexpectedly passed')
  })()
  const notesOmission = await expectReject('notes-omit-range', async target => {
    const notesPath = join(target, 'RELEASE-NOTES.md')
    const notes = (await readFile(notesPath, 'utf8')).replace(/^Supported DSH:.*\r?\n/m, '')
    await writeFile(notesPath, notes, 'utf8')
    const manifestPath = join(target, 'hub-release.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const buffer = await readFile(notesPath)
    manifest.releaseNotes.sha256 = sha256(buffer)
    manifest.releaseNotes.bytes = (await stat(notesPath)).size
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }, /notes omit DSH range/)
  const matrixDrift = await expectReject('matrix-range-drift', async target => {
    const matrixPath = join(target, 'compatibility/dsh-matrix.json')
    const matrix = JSON.parse(await readFile(matrixPath, 'utf8'))
    matrix.supportedRange = '>=0.2.0 <0.3.0'
    await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8')
    const manifestPath = join(target, 'hub-release.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const buffer = await readFile(matrixPath)
    manifest.matrix.sha256 = sha256(buffer)
    manifest.matrix.bytes = (await stat(matrixPath)).size
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }, /dsh-range-mismatch|DSH range drift/)

  const evidence = {
    schemaVersion: 1,
    subject: 'Hub release declares and enforces its supported DSH range',
    packageName: valid.packageName,
    version: valid.version,
    dshRange: valid.dshRange,
    verifiedVersions: valid.verifiedVersions,
    discoveryKeywords: ['dsh', 'dsh-plugin', 'dsh-flow', 'dsh-flow-hub', 'dsh-hub', 'deepseek-harness'],
    validCandidate: true,
    negativeCases: [wrongTag, notesOmission, matrixDrift],
    privatePathsRecorded: false
  }
  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} finally {
  const guardedRoot = resolve(tmpdir())
  if (!tempRoot.startsWith(guardedRoot)) throw new Error('refusing to remove release-contract path outside temp root')
  await rm(tempRoot, { recursive: true, force: true })
}
