import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'

const discoveryPath = resolve(process.argv[2] ?? 'registry/discovery/github-topic-2026-08-16.json')
const verificationDir = resolve(process.argv[3] ?? 'registry/verifications')
const flowDir = resolve(process.argv[4] ?? 'registry/flows')
const projectRoot = resolve('.')

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function publicStringProblem(value) {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(?:Users|home)\//.test(value)) return 'private-absolute-path'
  if (/^(?:file:|link:)/i.test(value)) return 'local-package-source'
  if (/(?:github_pat_|ghp_|sk-[A-Za-z0-9]{12,}|Bearer\s+[A-Za-z0-9._-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(value)) return 'credential-material'
  return null
}

function inspectPublicValues(value, at = '$') {
  if (typeof value === 'string') {
    const problem = publicStringProblem(value)
    if (problem !== null) throw new Error(`${problem} at ${at}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => { inspectPublicValues(item, `${at}[${index}]`) })
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) inspectPublicValues(item, `${at}.${key}`)
  }
}

async function assertEvidence(evidence, subject) {
  for (const item of evidence) {
    if (/^https:\/\//.test(item)) continue
    if (item.includes('..') || item.startsWith('/') || /^[A-Za-z]:/.test(item)) throw new Error(`unsafe evidence path for ${subject}: ${item}`)
    const target = resolve(projectRoot, item)
    const projectRelative = relative(projectRoot, target)
    if (projectRelative.startsWith('..') || isAbsolute(projectRelative)) throw new Error(`evidence escapes project for ${subject}: ${item}`)
    if (!(await stat(target)).isFile()) throw new Error(`evidence is not a file for ${subject}: ${item}`)
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const discoverySchema = await json(resolve('schemas/discovery-snapshot.schema.json'))
const verificationSchema = await json(resolve('schemas/verification-result.schema.json'))
const flowSchema = await json(resolve('schemas/harness-flow.schema.json'))
const validateDiscovery = ajv.compile(discoverySchema)
const validateVerification = ajv.compile(verificationSchema)
const validateFlow = ajv.compile(flowSchema)
const discovery = await json(discoveryPath)
if (!validateDiscovery(discovery)) throw new Error(`invalid discovery snapshot: ${ajv.errorsText(validateDiscovery.errors)}`)
inspectPublicValues(discovery)

const packageNames = new Set()
const ids = new Set()
for (const candidate of discovery.candidates) {
  if (packageNames.has(candidate.package.name)) throw new Error(`duplicate package candidate: ${candidate.package.name}`)
  packageNames.add(candidate.package.name)
  const id = candidate.package.name.toLowerCase().replace('/', '--').replaceAll(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '')
  if (ids.has(id)) throw new Error(`duplicate normalized candidate id: ${id}`)
  ids.add(id)
  if (candidate.source.kind === 'npm' && candidate.source.spec !== `${candidate.package.name}@${candidate.package.version}`) {
    throw new Error(`npm source is not exact for ${candidate.package.name}`)
  }
  if (candidate.source.kind === 'github-sha' && candidate.source.spec !== `github:${candidate.repository}#${candidate.source.commit}`) {
    throw new Error(`GitHub source is not pinned exactly for ${candidate.package.name}`)
  }
}

const verificationNames = (await readdir(verificationDir)).filter(name => name.endsWith('.json')).sort()
let relevant = 0
for (const name of verificationNames) {
  const result = await json(resolve(verificationDir, name))
  if (!validateVerification(result)) throw new Error(`invalid verification ${name}: ${ajv.errorsText(validateVerification.errors)}`)
  inspectPublicValues(result)
  await assertEvidence(result.evidence, result.subject)
  if (ids.has(result.subject)) relevant += 1
}

const flowNames = (await readdir(flowDir)).filter(name => name.endsWith('.dsh-flow.yml')).sort()
const flowIds = new Set()
for (const name of flowNames) {
  const flow = parseYaml(await readFile(resolve(flowDir, name), 'utf8'))
  if (!validateFlow(flow)) throw new Error(`invalid Flow ${name}: ${ajv.errorsText(validateFlow.errors)}`)
  inspectPublicValues(flow)
  if (flowIds.has(flow.id)) throw new Error(`duplicate Flow id: ${flow.id}`)
  flowIds.add(flow.id)
  for (const variant of Object.values(flow.variants)) {
    for (const plugin of variant.plugins) {
      if (plugin.relationship === 'conflict') continue
      const candidate = discovery.candidates.find(item => item.package.name === plugin.package && item.package.version === plugin.range)
      if (candidate === undefined) throw new Error(`Flow ${flow.id} has unresolved exact plugin ${plugin.package}@${plugin.range}`)
    }
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, discovery: discoveryPath, candidates: discovery.candidates.length, verifications: verificationNames.length, relevant, flows: flowNames.length })}\n`)
