import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'
import { compareFlowVariants, compileFlowInstallPlan, compileStackPreview } from '../lib/flow-resolver.js'

async function fixture() {
  const flow = parseYaml(await readFile(resolve('registry/flows/coding-expert.dsh-flow.yml'), 'utf8'))
  const registry = JSON.parse(await readFile(resolve('registry/generated/registry.json'), 'utf8'))
  return { flow, registry }
}

test('Coding Expert manifest and deterministic Lite Stack satisfy public schemas', async () => {
  const { flow, registry } = await fixture()
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  const validateFlow = ajv.compile(JSON.parse(await readFile(resolve('schemas/harness-flow.schema.json'), 'utf8')))
  assert.equal(validateFlow(flow), true, ajv.errorsText(validateFlow.errors))
  const options = { generatedAt: '2026-08-16T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: 'win32', arch: 'x64', node: 'v24.0.0' }
  const first = compileStackPreview(flow, 'lite', registry.plugins, options)
  const second = compileStackPreview(flow, 'lite', registry.plugins, options)
  assert.deepEqual(first, second)
  assert.equal(first.profile, 'flow-coding-expert-lite')
  assert.deepEqual(first.packages.map(item => item.package), ['dsh-mnemon', 'dsh-plugin-writing-guard'])
  assert.match(first.flow.digest, /^sha256:[a-f0-9]{64}$/)
  assert.match(first.configDigest, /^sha256:[a-f0-9]{64}$/)
  const validateStack = ajv.compile(JSON.parse(await readFile(resolve('schemas/stack-lock.schema.json'), 'utf8')))
  assert.equal(validateStack(first), true, ajv.errorsText(validateStack.errors))
  assert.doesNotMatch(JSON.stringify(first), /(?:API_KEY|C:\\Users\\|\/home\/)/i)

  const plan = compileFlowInstallPlan(flow, 'lite', registry.plugins, { ...options, registrySignature: 'unverified' })
  assert.deepEqual(plan, compileFlowInstallPlan(flow, 'lite', registry.plugins, { ...options, registrySignature: 'unverified' }))
  assert.equal(plan.profile.name, 'flow-coding-expert-lite')
  assert.equal(plan.profile.template, 'headless')
  assert.equal(plan.executable, false)
  assert.deepEqual(plan.operations.map(item => item.source.spec), ['dsh-mnemon@0.1.6', 'dsh-plugin-writing-guard@0.9.2'])
  assert.ok(plan.blockers.includes('registry-signature-not-verified'))
  assert.ok(plan.blockers.includes('plugin-not-verified:dsh-mnemon:unverified'))
  assert.deepEqual(plan.steps, ['preflight', 'initialize-profile', 'snapshot', 'staging', 'install-packages', 'dump-config', 'boot-smoke', 'commit', 'health', 'write-stack-lock'])
  const validatePlan = ajv.compile(JSON.parse(await readFile(resolve('schemas/flow-install-plan.schema.json'), 'utf8')))
  assert.equal(validatePlan(plan), true, ajv.errorsText(validatePlan.errors))
  assert.doesNotMatch(JSON.stringify(plan), /(?:API_KEY|C:\\Users\\|\/home\/)/i)
})

test('Lite and Safe comparison exposes exact plugin differences', async () => {
  const { flow } = await fixture()
  assert.deepEqual(compareFlowVariants(flow, 'lite', 'safe'), {
    added: [], removed: ['dsh-mnemon'], shared: ['dsh-plugin-writing-guard'],
  })
})

test('Stack preview fails closed for unresolved, failed and ambiguous packages', async () => {
  const { flow, registry } = await fixture()
  const options = { generatedAt: '2026-08-16T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: 'linux', arch: 'x64', node: 'v24.0.0' }
  assert.throws(() => compileStackPreview(flow, 'lite', [], options), /flow-package-unresolved/)
  const failed = structuredClone(registry.plugins)
  failed.find(item => item.package === 'dsh-mnemon').verification.state = 'failed'
  assert.throws(() => compileStackPreview(flow, 'lite', failed, options), /flow-package-not-eligible/)
  const ambiguous = structuredClone(flow)
  ambiguous.variants.lite.plugins.push({ package: 'another-plugin', range: '1.0.0', relationship: 'alternative', alternativeGroup: 'memory' })
  assert.throws(() => compileStackPreview(ambiguous, 'lite', registry.plugins, options), /flow-alternative-requires-explicit-selection/)
  assert.throws(() => compileStackPreview(flow, 'standard', registry.plugins, options), /flow-variant-unavailable/)
})

test('Flow selection handles recommended, alternative and conflict relationships explicitly', async () => {
  const { flow, registry } = await fixture()
  const options = { generatedAt: '2026-08-16T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: 'linux', arch: 'x64', node: 'v24.0.0' }
  assert.deepEqual(compileStackPreview(flow, 'lite', registry.plugins, { ...options, includeRecommended: false }).packages.map(item => item.package), ['dsh-mnemon'])

  const selectable = structuredClone(flow)
  selectable.variants.lite.plugins.push({ package: 'another-plugin', range: '1.0.0', relationship: 'alternative', alternativeGroup: 'memory' })
  const candidates = [...registry.plugins, {
    package: 'another-plugin', version: '1.0.0', source: { kind: 'npm', spec: 'another-plugin@1.0.0', integrity: 'sha512-test' },
    compatibility: { dsh: '>=0.1.0-rc.6 <0.2.0' }, platforms: ['linux'], lifecycleScripts: {}, permissions: [], credentials: [], verification: { state: 'passed' },
  }]
  assert.ok(compileStackPreview(selectable, 'lite', candidates, { ...options, alternatives: { memory: 'another-plugin' } }).packages.some(item => item.package === 'another-plugin'))
  assert.throws(() => compileStackPreview(selectable, 'lite', candidates, { ...options, alternatives: { memory: 'missing' } }), /flow-alternative-invalid-selection/)

  const conflict = structuredClone(flow)
  conflict.variants.lite.plugins.push({ package: 'dsh-mnemon', range: '0.1.6', relationship: 'conflict' })
  assert.throws(() => compileStackPreview(conflict, 'lite', registry.plugins, options), /flow-plugin-conflict/)
})

test('Flow install plan opens only when signature, verification, compatibility and platform gates pass', async () => {
  const { flow, registry } = await fixture()
  const trusted = structuredClone(registry.plugins)
  for (const candidate of trusted.filter(item => ['dsh-mnemon', 'dsh-plugin-writing-guard'].includes(item.package))) {
    candidate.verification.state = 'passed'
    candidate.compatibility.dsh = '>=0.1.0-rc.6 <0.2.0'
    candidate.platforms = ['linux']
  }
  const plan = compileFlowInstallPlan(flow, 'lite', trusted, {
    generatedAt: '2026-08-16T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: 'linux', arch: 'x64', node: 'v24.0.0', registrySignature: 'verified',
  })
  assert.equal(plan.executable, true)
  assert.deepEqual(plan.blockers, [])

  trusted.find(item => item.package === 'dsh-mnemon').compatibility.dsh = '>=0.2.0 <0.3.0'
  const incompatible = compileFlowInstallPlan(flow, 'lite', trusted, {
    generatedAt: '2026-08-16T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: 'linux', arch: 'x64', node: 'v24.0.0', registrySignature: 'verified',
  })
  assert.equal(incompatible.executable, false)
  assert.ok(incompatible.blockers.includes('plugin-dsh-incompatible:dsh-mnemon:>=0.2.0 <0.3.0'))
})
