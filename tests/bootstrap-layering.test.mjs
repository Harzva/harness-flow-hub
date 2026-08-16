import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decideBootstrapRuntime } from '../lib/bootstrap-policy.js'

test('Bootstrap initializes the full UI only for a confirmed compatible snapshot', () => {
  const compatible = decideBootstrapRuntime({ ok: true, state: 'compatible' })
  assert.equal(compatible.mode, 'full-ui')
  assert.equal(compatible.loadFullUi, true)
  assert.equal(compatible.allowMutations, true)
  assert.deepEqual(compatible.initialEndpoints, [
    '/flow-hub/api/registry', '/flow-hub/api/profiles', '/flow-hub/api/tasks', '/flow-hub/api/flows',
  ])

  for (const candidate of [
    decideBootstrapRuntime(null),
    decideBootstrapRuntime(null, true),
    decideBootstrapRuntime({ ok: true, state: 'unknown' }),
    decideBootstrapRuntime({ ok: true, state: 'incompatible' }),
    decideBootstrapRuntime({ ok: false, state: 'compatible' }),
  ]) {
    assert.equal(candidate.loadFullUi, false)
    assert.equal(candidate.allowMutations, false)
    assert.deepEqual(candidate.initialEndpoints, ['/flow-hub/api/bootstrap'])
  }
})

test('safe Bootstrap keeps recovery local and full data calls behind the compatibility gate', async () => {
  const bootstrap = await readFile('src/client/bootstrap.tsx', 'utf8')
  const fullUi = await readFile('src/client/index.tsx', 'utf8')
  assert.match(bootstrap, /decideBootstrapRuntime\(bootstrap, failed\)/)
  assert.match(bootstrap, /if \(runtime\.loadFullUi && bootstrap !== null\)/)
  assert.match(bootstrap, /dsh plugin --profile web remove @harness-flow\/dsh-flow-hub/)
  assert.match(bootstrap, /完整 Flow Hub 已保持关闭/)
  assert.doesNotMatch(bootstrap, /api\/registry|api\/profiles|api\/tasks|api\/flows|api\/plan|api\/plugin|api\/rollback/)
  assert.doesNotMatch(bootstrap, /window\.open|location\.(?:assign|replace)|<a\s/i)
  assert.doesNotMatch(fullUi, /api<BootstrapResponse>\('bootstrap'\)/)
})
