import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { compileFlowInstallPlan, compileStackPreview } from '../lib/flow-resolver.js'
import { evaluateRegistryTrust } from '../lib/registry-trust.js'

const output = resolve(process.argv[2] ?? 'evidence/m2-recommendation-trust-gate-2026-08-17.json')
const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
const flow = parseYaml(await readFile('registry/flows/coding-expert.dsh-flow.yml', 'utf8'))
const options = { generatedAt: '2026-08-17T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: process.platform === 'win32' ? 'win32' : 'linux', arch: process.arch, node: process.version }
const requiredPackage = 'dsh-openwolf'
const recommendedPackage = 'dsh-mnemon'

const missingTrust = evaluateRegistryTrust({ registryText: JSON.stringify(registry), now: options.generatedAt })
assert.equal(missingTrust.allowRecommendations, false)
const unsignedPlan = compileFlowInstallPlan(flow, 'lite', registry.plugins, { ...options, registrySignature: 'unverified' })
assert.deepEqual(unsignedPlan.operations.map(item => item.package), [requiredPackage])
assert.ok(unsignedPlan.blockers.includes('registry-signature-not-verified'))

const trusted = structuredClone(registry.plugins)
for (const candidate of trusted.filter(item => [requiredPackage, recommendedPackage].includes(item.package))) {
  candidate.verification.state = 'passed'
  candidate.compatibility.dsh = '>=0.1.0-rc.6 <0.2.0'
  candidate.platforms = [options.platform]
}
const signedPlan = compileFlowInstallPlan(flow, 'lite', trusted, { ...options, registrySignature: 'verified' })
assert.deepEqual(signedPlan.operations.map(item => item.package), [recommendedPackage, requiredPackage])
assert.equal(signedPlan.executable, true)

const floating = structuredClone(trusted)
floating.find(item => item.package === recommendedPackage).source = {
  kind: 'github-sha', spec: 'github:owner/repo#main', commit: '0123456789abcdef0123456789abcdef01234567',
}
assert.throws(() => compileStackPreview(flow, 'lite', floating, options), /flow-package-source-unpinned/)

const stale = structuredClone(trusted)
stale.find(item => item.package === recommendedPackage).verification.state = 'stale'
assert.throws(() => compileStackPreview(flow, 'lite', stale, options), /flow-package-not-eligible/)

const [host, client] = await Promise.all([readFile('src/index.ts', 'utf8'), readFile('src/client/index.tsx', 'utf8')])
assert.match(host, /includeRecommended: registryTrust\.allowRecommendations/)
assert.match(client, /推荐依赖已锁定/)
assert.match(client, /不会静默加入 recommended 插件/)

const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  subject: 'Fail-closed Flow recommendation trust gate',
  checks: {
    invalidSignatureRecommendationAllowed: false,
    invalidSignatureRecommendedPackageIncluded: false,
    verifiedSignatureRecommendedPackageIncluded: true,
    floatingSourceRecommendationBlocked: true,
    staleVerificationRecommendationBlocked: true,
    explicitNativeUiNotice: true,
  },
  policy: { requiredDependenciesRemainVisibleForReview: true, recommendationsRequireVerifiedRegistry: true, sourcesMustBeExact: true, staleCandidatesEligible: false },
  privacy: { credentialsCaptured: false, privatePathsRecorded: false, userContentCaptured: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, recommendationGate: 'passed' })}\n`)
