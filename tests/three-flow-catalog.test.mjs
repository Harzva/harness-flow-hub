import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('catalog provides three complete Flow types and four deterministic variants each', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/verify-three-flow-catalog.mjs'])
  const evidence = JSON.parse(stdout)
  assert.equal(evidence.result, 'passed')
  assert.deepEqual(evidence.checks.categories, ['domain-expert', 'task-expert', 'work-environment'])
  assert.deepEqual(evidence.checks.variantsPerFlow, ['lite', 'standard', 'local', 'safe'])
  assert.equal(evidence.checks.deterministicStackCount, 12)
  assert.equal(evidence.checks.uniqueProfileCount, 12)
  assert.equal(evidence.checks.unverifiedDependenciesFailClosed, true)
  assert.equal(evidence.privacy.privatePathsRecorded, false)
})

test('native DSH Flow catalog can switch among all Flow definitions without leaving the app', async () => {
  const source = await readFile('src/client/index.tsx', 'utf8')
  assert.match(source, /aria-label="选择 Harness Flow"/)
  assert.match(source, /flows\.map\(item => <button/)
  assert.match(source, /aria-pressed=\{item\.id === flow\.id\}/)
  assert.match(source, /setFlowId\(item\.id\)/)
  assert.match(source, /setVariantId\(item\.variants\[0\]\?\.id \?\? 'lite'\)/)
  assert.doesNotMatch(source, /flowHubFlowPicker[^>]+href=/)
})
