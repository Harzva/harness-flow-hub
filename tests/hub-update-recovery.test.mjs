import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Hub update recovery verifier uses official DSH commands and proves whole-Profile restoration', async () => {
  const [script, fixture, registryWorkflow, matrixWorkflow] = await Promise.all([
    readFile('scripts/verify-hub-update-recovery.mjs', 'utf8'),
    readFile('fixtures/dsh-flow-hub-recovery-baseline/package.json', 'utf8'),
    readFile('.github/workflows/registry.yml', 'utf8'),
    readFile('.github/workflows/dsh-compatibility.yml', 'utf8'),
  ])
  assert.match(fixture, /"name": "@harness-flow\/dsh-flow-hub"/)
  assert.match(fixture, /"version": "0\.0\.1-recovery-fixture"/)
  assert.match(script, /\['plugin', '--profile', 'web', 'add'/)
  assert.match(script, /'>=0\.2\.0 <0\.3\.0'/)
  assert.match(script, /failAt: 'health'/)
  assert.match(script, /treeByteDigestRestored: true/)
  assert.match(script, /privatePathsRecorded: false/)
  assert.match(registryWorkflow, /transaction:verify-hub-update-recovery/)
  assert.match(matrixWorkflow, /verify-hub-update-recovery\.mjs/)
})
