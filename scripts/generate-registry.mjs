import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'
import { resolveVerificationState } from './verification-state-lib.mjs'

const input = resolve(process.argv[2] ?? 'registry/discovery/github-topic-2026-08-16.json')
const output = resolve(process.argv[3] ?? 'registry/generated/registry.json')
const sourceText = await readFile(input, 'utf8')
const source = JSON.parse(sourceText)
const verificationDir = resolve('registry/verifications')
const flowDir = resolve('registry/flows')
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
const flowSchema = JSON.parse(await readFile(resolve('schemas/harness-flow.schema.json'), 'utf8'))
const flowAjv = new Ajv2020({ allErrors: true, strict: true })
const validateFlow = flowAjv.compile(flowSchema)
const flowNames = (await readdir(flowDir)).filter(name => name.endsWith('.dsh-flow.yml')).sort()

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalized(item)]))
  return value
}

function canonical(value) {
  return JSON.stringify(normalized(value))
}

const flowInputs = await Promise.all(flowNames.map(async name => {
  const path = resolve(flowDir, name)
  const flow = parseYaml(await readFile(path, 'utf8'))
  if (!validateFlow(flow)) throw new Error(`invalid Flow ${name}: ${flowAjv.errorsText(validateFlow.errors)}`)
  return { name, path, flow }
}))
const sha256 = createHash('sha256')
  .update(JSON.stringify(source))
  .update(verificationInputs.map(item => `\0${item.name}\0${JSON.stringify(item.result)}`).join(''))
  .update(flowInputs.map(item => `\0${item.name}\0${canonical(item.flow)}`).join(''))
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

const flows = flowInputs.map(({ path, flow }) => ({
  schemaVersion: 1,
  id: flow.id,
  version: flow.version,
  manifest: relative(resolve('.'), path).split(sep).join('/'),
  digest: `sha256:${createHash('sha256').update(canonical(flow)).digest('hex')}`,
  variants: Object.keys(flow.variants).sort(),
  verification: {
    schemaVersion: 1,
    subject: flow.id,
    state: 'unverified',
    checks: [{ id: 'manifest-schema', status: 'passed', detail: 'Harness Flow schema v1' }],
    evidence: [relative(resolve('.'), path).split(sep).join('/')],
  },
})).sort((left, right) => left.id.localeCompare(right.id))

const registry = {
  schemaVersion: 1,
  registryVersion: `${source.source.asOf.replaceAll('-', '.')}-alpha.1`,
  generatedFrom: { kind: source.source.kind, asOf: source.source.asOf, sha256 },
  plugins,
  flows,
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, plugins: plugins.length, flows: flows.length, sourceSha256: sha256 })}\n`)
