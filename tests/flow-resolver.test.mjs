import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'
import { compareFlowVariants, compileStackPreview } from '../lib/flow-resolver.js'

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
