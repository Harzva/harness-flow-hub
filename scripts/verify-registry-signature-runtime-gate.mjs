import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { compileFlowInstallPlan } from '../lib/flow-resolver.js'
import { evaluateRegistryTrust, signRegistry } from '../lib/registry-trust.js'
import { createInstallPlan, executeFlowInstallPlan, executeInstallPlan } from '../lib/transaction.js'

const output = resolve(process.argv[2] ?? 'evidence/m2-registry-signature-runtime-gate-2026-08-17.json')
const registryText = await readFile('registry/generated/registry.json', 'utf8')
const registry = JSON.parse(registryText)
const now = new Date('2026-08-17T00:00:00.000Z')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const envelope = signRegistry(registryText, privateKey, {
  keyId: 'ephemeral-ci-key', createdAt: '2026-08-16T00:00:00.000Z', expiresAt: '2026-08-18T00:00:00.000Z',
})
const revocations = { revokedKeyIds: [], revokedRegistryVersions: [] }

const cases = {
  verified: evaluateRegistryTrust({ registryText, envelope, publicKey, revocations, now }),
  missing: evaluateRegistryTrust({ registryText, now }),
  partial: evaluateRegistryTrust({ registryText, envelope, now }),
  tampered: evaluateRegistryTrust({ registryText: `${registryText} `, envelope, publicKey, revocations, now }),
  expired: evaluateRegistryTrust({ registryText, envelope, publicKey, revocations, now: '2026-08-19T00:00:00.000Z' }),
  keyRevoked: evaluateRegistryTrust({ registryText, envelope, publicKey, revocations: { ...revocations, revokedKeyIds: ['ephemeral-ci-key'] }, now }),
  registryRevoked: evaluateRegistryTrust({ registryText, envelope, publicKey, revocations: { ...revocations, revokedRegistryVersions: [registry.registryVersion] }, now }),
  invalidSignature: evaluateRegistryTrust({ registryText, envelope: { ...envelope, signature: Buffer.alloc(64).toString('base64') }, publicKey, revocations, now }),
}
assert.equal(cases.verified.status, 'verified')
assert.equal(cases.verified.allowInstallPlans, true)
for (const [name, result] of Object.entries(cases).filter(([name]) => name !== 'verified')) {
  assert.equal(result.allowInstallPlans, false, `${name} allowed an install plan`)
  assert.equal(result.allowRecommendations, false, `${name} allowed a recommendation`)
}

const flow = parseYaml(await readFile('registry/flows/coding-expert.dsh-flow.yml', 'utf8'))
const blockedPlan = compileFlowInstallPlan(flow, 'lite', registry.plugins, {
  generatedAt: now.toISOString(), dshVersion: '0.1.0-rc.6', platform: 'linux', arch: 'x64', node: process.version,
  registrySignature: cases.tampered.allowInstallPlans ? 'verified' : 'unverified',
})
assert.equal(blockedPlan.executable, false)
assert.ok(blockedPlan.blockers.includes('registry-signature-not-verified'))

const temp = await mkdtemp(join(tmpdir(), 'flow-hub-signature-gate-'))
let flowRunCalls = 0
let pluginRunCalls = 0
try {
  const flowResult = await executeFlowInstallPlan(blockedPlan, {
    home: temp, dshCli: 'unused', now: () => now, runtimePlatform: 'linux', dshVersion: '0.1.0-rc.6', minimumFreeBytes: 0,
    networkProbe: async () => true, bootSmoke: async () => ({ code: 0, stdout: '', stderr: '' }),
    run: async () => { flowRunCalls += 1; return { code: 0, stdout: '', stderr: '' } },
  })
  assert.equal(flowResult.ok, false)
  assert.match(flowResult.error, /flow-plan-not-executable/)

  const pluginPlan = createInstallPlan({
    action: 'add', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: '@harness-flow/hello-bundle@0.0.1',
    verification: 'passed', signature: 'unverified', now,
  })
  const pluginResult = await executeInstallPlan(pluginPlan, {
    home: temp, dshCli: 'unused', now: () => now, minimumFreeBytes: 0, networkProbe: async () => true,
    run: async () => { pluginRunCalls += 1; return { code: 0, stdout: '', stderr: '' } },
  })
  assert.equal(pluginResult.ok, false)
  assert.match(pluginResult.error, /registry-signature-unverified/)
} finally {
  await rm(temp, { recursive: true, force: true })
}
assert.equal(flowRunCalls, 0)
assert.equal(pluginRunCalls, 0)

const host = await readFile('src/index.ts', 'utf8')
const client = await readFile('src/client/index.tsx', 'utf8')
assert.match(host, /resolveBundledRegistryTrust/)
assert.match(host, /registrySignature: registryTrust\.allowInstallPlans \? 'verified' : 'unverified'/)
assert.match(client, /Registry 签名未通过，安装计划已锁定/)

const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  subject: 'Runtime Registry signature trust and silent-install blocking',
  cases: Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, { status: value.status, reason: value.reason, allowRecommendations: value.allowRecommendations, allowInstallPlans: value.allowInstallPlans }])),
  execution: { flowPlanBlocked: true, pluginPlanBlocked: true, dshWriteCalls: flowRunCalls + pluginRunCalls },
  ui: { explicitTrustFailureNotice: true, reasonExposed: true },
  privacy: { credentialsCaptured: false, privatePathsRecorded: false, userContentCaptured: false, ephemeralKeysPersisted: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, cases: Object.keys(cases).length, dshWriteCalls: 0, output })}\n`)
