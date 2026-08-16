import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyVersion, parseTestFailurePhase } from '../lib/index.js'

test('bootstrap classifier fails closed across compatible unknown and incompatible states', () => {
  assert.equal(classifyVersion(null), 'unknown')
  assert.equal(classifyVersion('0.1.0-rc.5'), 'incompatible')
  assert.equal(classifyVersion('0.1.0-rc.6'), 'compatible')
  assert.equal(classifyVersion('0.1.0'), 'compatible')
  assert.equal(classifyVersion('0.1.1'), 'compatible')
  assert.equal(classifyVersion('0.2.0'), 'incompatible')
})

test('management endpoint exposes only fixed plugin actions and structured rollback plans', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile('src/index.ts', 'utf8'))
  assert.match(source, /action !== 'add' && action !== 'update' && action !== 'remove'/)
  assert.match(source, /local-same-origin-required/)
  assert.match(source, /rollback-plan-missing-or-consumed/)
  assert.match(source, /recovery-point-unavailable/)
  assert.match(source, /pathname === `\$\{API_PATH\}\/flows`/)
  assert.match(source, /resolveFlowCatalog\(\)/)
})

test('test failure injection is server-configured and phase allowlisted', async () => {
  assert.equal(parseTestFailurePhase(undefined), undefined)
  assert.equal(parseTestFailurePhase(''), undefined)
  assert.equal(parseTestFailurePhase('health'), 'health')
  assert.throws(() => parseTestFailurePhase('shell'), /invalid-test-failure-phase:shell/)
  const host = await import('node:fs/promises').then(fs => fs.readFile('src/index.ts', 'utf8'))
  const client = await import('node:fs/promises').then(fs => fs.readFile('src/client/index.tsx', 'utf8'))
  assert.match(host, /failAt: testFailurePhase/)
  assert.doesNotMatch(client, /testFailAt/)
  assert.match(client, /隔离测试模式/)
})

test('v1 schemas are valid JSON and keep distinct responsibilities', async () => {
  const fs = await import('node:fs/promises')
  const entries = [
    ['plugin-record.schema.json', 'source'],
    ['harness-flow.schema.json', 'variants'],
    ['stack-lock.schema.json', 'packages'],
    ['registry-signature.schema.json', 'signature'],
    ['registry-revocations.schema.json', 'revokedRegistryVersions'],
    ['discovery-snapshot.schema.json', 'candidates'],
    ['registry-release-manifest.schema.json', 'files'],
    ['install-plan.schema.json', 'phases'],
    ['flow-install-plan.schema.json', 'operations'],
    ['rollback-plan.schema.json', 'backupId'],
  ]
  for (const [file, responsibility] of entries) {
    const schema = JSON.parse(await fs.readFile(`schemas/${file}`, 'utf8'))
    assert.equal(schema.properties.schemaVersion.const, 1)
    assert.ok(schema.required.includes(responsibility))
  }
})
