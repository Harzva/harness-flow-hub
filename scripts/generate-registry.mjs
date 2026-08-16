import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { resolveVerificationState } from './verification-state-lib.mjs'

const input = resolve(process.argv[2] ?? 'registry/discovery/github-topic-2026-08-16.json')
const output = resolve(process.argv[3] ?? 'registry/generated/registry.json')
const sourceText = await readFile(input, 'utf8')
const source = JSON.parse(sourceText)
const verificationDir = resolve('registry/verifications')
let verificationNames = []
try {
  verificationNames = (await readdir(verificationDir)).filter(name => name.endsWith('.json')).sort()
} catch {}
const candidateSubjects = new Set(source.candidates.map(candidate => idOf(candidate.package.name)))
const allVerificationInputs = await Promise.all(verificationNames.map(async name => ({
  name,
  result: JSON.parse(await readFile(resolve(verificationDir, name), 'utf8')),
})))
const verificationInputs = allVerificationInputs.filter(({ result }) => candidateSubjects.has(result.subject))
const verificationBySubject = new Map(verificationInputs.map(({ result }) => [result.subject, result]))
const sha256 = createHash('sha256')
  .update(JSON.stringify(source))
  .update(verificationInputs.map(item => `\0${item.name}\0${JSON.stringify(item.result)}`).join(''))
  .digest('hex')

function idOf(value) {
  return value.toLowerCase().replace('/', '--').replaceAll(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '')
}

const plugins = source.candidates.map(candidate => {
  const id = idOf(candidate.package.name)
  const result = verificationBySubject.get(id)
  const verificationState = resolveVerificationState(result, { asOf: source.source.asOf })
  return ({
  schemaVersion: 1,
  id,
  package: candidate.package.name,
  version: candidate.package.version,
  source: {
    kind: candidate.source.kind,
    spec: candidate.source.spec,
    ...(candidate.source.commit ? { commit: candidate.source.commit } : {}),
    ...(candidate.source.integrity ? { integrity: candidate.source.integrity } : {}),
  },
  compatibility: { dsh: 'unknown' },
  platforms: [],
  license: candidate.license,
  lifecycleScripts: candidate.package.scripts,
  permissions: [],
  credentials: [],
  verification: result === undefined ? {
    state: verificationState,
    evidence: [candidate.url],
  } : {
    state: verificationState,
    ...(result.verifiedAt ? { verifiedAt: result.verifiedAt } : {}),
    dshVersion: result.environment?.dsh,
    platform: result.environment?.os,
    evidence: [candidate.url, ...result.evidence],
  },
  })
}).sort((a, b) => a.id.localeCompare(b.id))

const registry = {
  schemaVersion: 1,
  registryVersion: `${source.source.asOf.replaceAll('-', '.')}-alpha.1`,
  generatedFrom: { kind: source.source.kind, asOf: source.source.asOf, sha256 },
  plugins,
  flows: [],
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, plugins: plugins.length, sourceSha256: sha256 })}\n`)
