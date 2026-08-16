import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { evaluateCompatibility, SUPPORTED_DSH_RANGE, VERIFIED_DSH_VERSIONS } from '../lib/compatibility.js'
import { buildDshCiMatrix, validateDshMatrixConfig } from '../scripts/dsh-matrix-lib.mjs'

const compatibleInput = {
  dshVersion: '0.1.0-rc.6',
  hubVersion: '0.0.2-m0',
  registrySchemaVersion: 1,
  flowSchemaVersions: [1, 1],
}

test('four-dimensional compatibility requires every dimension to be supported', () => {
  const result = evaluateCompatibility(compatibleInput)
  assert.equal(result.overall, 'compatible')
  assert.deepEqual(Object.fromEntries(Object.entries(result.dimensions).map(([name, value]) => [name, value.state])), {
    dsh: 'compatible', hub: 'compatible', registrySchema: 'compatible', flowSchema: 'compatible',
  })
  assert.equal(result.dimensions.dsh.supported, '>=0.1.0-rc.6 <0.2.0')
  assert.equal(result.dimensions.hub.supported, '>=0.0.2-m0 <0.1.0')
  assert.equal(result.dimensions.registrySchema.supported, '1.x')
  assert.equal(result.dimensions.flowSchema.supported, '1.x')
})

test('every incompatible dimension fails the overall gate closed', () => {
  const cases = [
    ['dsh', { dshVersion: '0.2.0' }],
    ['hub', { hubVersion: '0.1.0' }],
    ['registrySchema', { registrySchemaVersion: 2 }],
    ['flowSchema', { flowSchemaVersions: [1, 2] }],
  ]
  for (const [name, patch] of cases) {
    const result = evaluateCompatibility({ ...compatibleInput, ...patch })
    assert.equal(result.overall, 'incompatible', name)
    assert.equal(result.dimensions[name].state, 'incompatible', name)
  }
})

test('missing dimensions remain unknown and malformed metadata is incompatible', () => {
  const missing = evaluateCompatibility({ dshVersion: null, hubVersion: null, registrySchemaVersion: null, flowSchemaVersions: [] })
  assert.equal(missing.overall, 'unknown')
  assert.ok(Object.values(missing.dimensions).every(value => value.state === 'unknown'))

  const malformed = evaluateCompatibility({ ...compatibleInput, registrySchemaVersion: '1', flowSchemaVersions: [null] })
  assert.equal(malformed.overall, 'incompatible')
  assert.equal(malformed.dimensions.registrySchema.reason, 'invalid-schema-version')
  assert.equal(malformed.dimensions.flowSchema.reason, 'invalid-flow-schema-version')
})

test('incompatible takes precedence over unknown in the aggregate state', () => {
  const result = evaluateCompatibility({ ...compatibleInput, dshVersion: null, flowSchemaVersions: [2] })
  assert.equal(result.dimensions.dsh.state, 'unknown')
  assert.equal(result.dimensions.flowSchema.state, 'incompatible')
  assert.equal(result.overall, 'incompatible')
})

test('range-compatible but unverified DSH releases stay unknown until the matrix is extended', () => {
  assert.deepEqual(VERIFIED_DSH_VERSIONS, ['0.1.0-rc.6'])
  const result = evaluateCompatibility({ ...compatibleInput, dshVersion: '0.1.0-rc.7' })
  assert.equal(result.overall, 'unknown')
  assert.equal(result.dimensions.dsh.state, 'unknown')
  assert.equal(result.dimensions.dsh.reason, 'version-not-verified')
})

test('published DSH matrix is explicit, cross-platform and aligned with the Bootstrap allowlist', async () => {
  const config = validateDshMatrixConfig(JSON.parse(await readFile('compatibility/dsh-matrix.json', 'utf8')))
  assert.deepEqual(config.platforms, ['windows-latest', 'ubuntu-latest'])
  assert.equal(config.supportedRange, SUPPORTED_DSH_RANGE)
  assert.deepEqual(config.entries.filter(entry => entry.expected === 'compatible').map(entry => entry.version), [...VERIFIED_DSH_VERSIONS])
  const matrix = buildDshCiMatrix(config, config.observedDistTags)
  assert.equal(matrix.include.length, 6)
  assert.deepEqual(new Set(matrix.include.map(entry => entry.version)), new Set(['0.1.0-rc.6', '0.1.0-rc.3', '0.1.0-rc.2']))
  assert.ok(matrix.include.filter(entry => entry.role === 'current').every(entry => entry.verification === 'full-lifecycle'))
})

test('new npm dist-tags enter the matrix as unknown without silently extending compatibility', async () => {
  const config = JSON.parse(await readFile('compatibility/dsh-matrix.json', 'utf8'))
  const matrix = buildDshCiMatrix(config, { latest: '0.1.0-rc.7', next: '0.1.0-rc.7' })
  const candidate = matrix.include.filter(entry => entry.role === 'candidate-latest')
  assert.equal(candidate.length, 2)
  assert.ok(candidate.every(entry => entry.version === '0.1.0-rc.7' && entry.expected === 'unknown' && entry.verification === 'release-regression'))
  assert.equal(matrix.include.some(entry => entry.role === 'candidate-next'), false)
  const breaking = buildDshCiMatrix(config, { latest: '0.2.0', next: '0.2.0' })
  assert.ok(breaking.include.filter(entry => entry.role === 'candidate-latest').every(entry => entry.expected === 'incompatible' && entry.verification === 'release-regression'))
  const forced = buildDshCiMatrix(config, config.observedDistTags, { forcedCandidate: '0.1.0-rc.6' })
  assert.equal(forced.include.filter(entry => entry.role === 'candidate-forced').length, 2)
  assert.ok(forced.include.filter(entry => entry.role === 'candidate-forced').every(entry => entry.expected === 'compatible' && entry.verification === 'release-regression'))
  assert.throws(() => buildDshCiMatrix(config, config.observedDistTags, { forcedCandidate: 'latest' }), /invalid-forced-candidate/)
})

test('hosted compatibility workflow installs exact published binaries and retains matrix evidence', async () => {
  const [workflow, resolver] = await Promise.all([
    readFile('.github/workflows/dsh-compatibility.yml', 'utf8').then(parseYaml),
    readFile('scripts/resolve-dsh-ci-matrix.mjs', 'utf8'),
  ])
  assert.equal(workflow.on.schedule[0].cron, '23 3 * * *')
  assert.deepEqual(workflow.on.repository_dispatch.types, ['dsh-release'])
  assert.equal(workflow.on.workflow_dispatch.inputs.candidate_version.type, 'string')
  assert.match(resolver, /metadata\.versions/)
  assert.match(resolver, /candidate-version-not-published/)
  assert.match(workflow.jobs.configure.outputs.matrix, /steps\.matrix\.outputs\.matrix/)
  const verify = workflow.jobs.verify
  assert.equal(verify.strategy['fail-fast'], false)
  assert.match(verify.strategy.matrix, /fromJSON\(needs\.configure\.outputs\.matrix\)/)
  const install = verify.steps.find(step => step.name === 'Install exact published DSH package')
  assert.match(install.run, /@deepseek-ai\/dsh@\$\{\{ matrix\.version \}\}/)
  assert.match(install.run, /Copy-Item -LiteralPath 'pnpm-workspace\.yaml'/)
  assert.doesNotMatch(install.run, /approve-builds|--allow-build/)
  const entry = verify.steps.find(step => step.name?.startsWith('Verify Web, Bootstrap'))
  assert.equal(entry.run, 'pnpm run ui:verify-dsh-version-entry')
  const lifecycle = verify.steps.find(step => step.name?.startsWith('Verify current DSH full'))
  assert.equal(lifecycle.if, "matrix.verification == 'full-lifecycle'")
  assert.match(lifecycle.run, /verify-native-ui-lifecycle\.mjs/)
  assert.match(lifecycle.run, /evidence-ci\/dsh-matrix/)
  const candidateUi = verify.steps.find(step => step.name?.startsWith('Verify trusted release candidate'))
  assert.match(candidateUi.if, /release-regression.*compatible/)
  assert.match(candidateUi.run, /verify-native-ui-lifecycle\.mjs/)
  const qualification = verify.steps.find(step => step.name?.startsWith('Qualify in-range release candidate'))
  assert.match(qualification.if, /release-regression.*incompatible/)
  assert.match(qualification.run, /verify-transaction-lifecycle\.mjs/)
  assert.match(qualification.run, /verify-transaction-version-lifecycle\.mjs/)
  assert.match(qualification.run, /verify-rollback-lifecycle\.mjs/)
  const upload = verify.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(upload.if, 'always()')
  assert.match(upload.with.path, /evidence-ci\/dsh-matrix/)
  assert.doesNotMatch(upload.with.path, /evidence\/m2-native-ui-lifecycle/)
})
