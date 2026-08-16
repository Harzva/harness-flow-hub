import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const registryPath = resolve(process.argv[2] ?? 'registry/generated/registry.json')
const output = resolve(process.argv[3] ?? 'evidence/m2-registry-verification-traceability-2026-08-17.json')
const checkPublicLinks = process.argv.includes('--check-public-links')
const registry = JSON.parse(await readFile(registryPath, 'utf8'))
const releaseTag = `registry-v${registry.registryVersion}`
const publicPrefix = `https://github.com/Harzva/harness-flow-hub/blob/${releaseTag}/registry/verifications/`
const runtimeRecords = registry.plugins.filter(plugin => typeof plugin.verification?.verifiedAt === 'string')
const withoutRuntimeEvidence = registry.plugins.filter(plugin => typeof plugin.verification?.verifiedAt !== 'string')

function requireTrue(condition, message) {
  if (!condition) throw new Error(message)
}

function containsPrivateMaterial(value) {
  return /(?:(?:^|["'])[A-Za-z]:[\\/]|\\\\|\/(?:Users|home)\/|github_pat_|ghp_|sk-[A-Za-z0-9]{12,}|Bearer\s+|PRIVATE KEY)/.test(value)
}

const publicLinks = []
for (const plugin of runtimeRecords) {
  const verification = plugin.verification
  const localEvidence = `registry/verifications/${plugin.id}.json`
  const publicEvidence = `${publicPrefix}${plugin.id}.json`
  requireTrue(Number.isFinite(Date.parse(verification.verifiedAt)), `invalid verification time:${plugin.id}`)
  requireTrue(typeof verification.dshVersion === 'string' && verification.dshVersion.length > 0, `missing DSH version:${plugin.id}`)
  requireTrue(['win32', 'linux', 'darwin'].includes(verification.environment?.os), `missing environment OS:${plugin.id}`)
  requireTrue(typeof verification.environment?.arch === 'string' && verification.environment.arch.length > 0, `missing environment architecture:${plugin.id}`)
  requireTrue(typeof verification.environment?.node === 'string' && verification.environment.node.length > 0, `missing Node environment:${plugin.id}`)
  requireTrue(verification.evidence?.includes(localEvidence), `missing packaged evidence:${plugin.id}`)
  requireTrue(verification.evidence?.includes(publicEvidence), `missing public evidence link:${plugin.id}`)
  const source = JSON.parse(await readFile(resolve(localEvidence), 'utf8'))
  requireTrue(source.subject === plugin.id, `evidence subject mismatch:${plugin.id}`)
  requireTrue(source.verifiedAt === verification.verifiedAt, `evidence time mismatch:${plugin.id}`)
  requireTrue(source.environment?.dsh === verification.dshVersion, `evidence DSH mismatch:${plugin.id}`)
  requireTrue(source.environment?.os === verification.environment.os && source.environment?.arch === verification.environment.arch && source.environment?.node === verification.environment.node, `evidence environment mismatch:${plugin.id}`)
  publicLinks.push(publicEvidence)
}

const serialized = JSON.stringify(registry)
requireTrue(!containsPrivateMaterial(serialized), 'Registry contains credentials or private paths')

let reachable = null
if (checkPublicLinks) {
  const results = await Promise.all(publicLinks.map(async url => {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) })
      return response.ok
    } catch {
      return false
    }
  }))
  reachable = results.filter(Boolean).length
  requireTrue(reachable === publicLinks.length, `public evidence links unreachable:${reachable}/${publicLinks.length}`)
}

const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  subject: 'Registry verification result traceability',
  registryVersion: registry.registryVersion,
  releaseTag,
  checks: {
    plugins: registry.plugins.length,
    runtimeRecords: runtimeRecords.length,
    recordsWithoutRuntimeClaims: withoutRuntimeEvidence.length,
    timestampComplete: runtimeRecords.length,
    environmentComplete: runtimeRecords.length,
    dshVersionComplete: runtimeRecords.length,
    packagedEvidenceComplete: runtimeRecords.length,
    publicEvidenceComplete: publicLinks.length,
    publicEvidenceReachable: reachable,
  },
  publicEvidence: { scheme: 'https', immutableTag: releaseTag, checkedOnline: checkPublicLinks },
  privacy: { credentialsCaptured: false, privatePathsRecorded: false, userContentCaptured: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, runtimeRecords: runtimeRecords.length, publicLinks: publicLinks.length, reachable, output })}\n`)
