import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildBootstrapRecoveryGuidance, decideBootstrapRuntime } from '../lib/bootstrap-policy.js'

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
  assert.equal(decideBootstrapRuntime({ ok: true, state: 'unknown' }).mode, 'read-only')
  assert.equal(decideBootstrapRuntime({ ok: true, state: 'incompatible' }).mode, 'safe-recovery')
  assert.equal(decideBootstrapRuntime({ ok: false, state: 'compatible' }).reason, 'bootstrap-unavailable')
})

test('read-only and incompatible states expose fixed update and rescue guidance without executing commands', () => {
  const unknown = buildBootstrapRecoveryGuidance(decideBootstrapRuntime({ ok: true, state: 'unknown' }), {
    profile: 'research', packageName: '@harness-flow/dsh-flow-hub', hubVersion: '0.0.2-m0',
  })
  assert.equal(unknown.badge, 'read-only')
  assert.match(unknown.summary, /保持只读/)
  assert.equal(unknown.updateCommand, 'dsh plugin --profile research update @harness-flow/dsh-flow-hub')
  assert.equal(unknown.removeCommand, 'dsh plugin --profile research remove @harness-flow/dsh-flow-hub')

  const incompatible = buildBootstrapRecoveryGuidance(decideBootstrapRuntime({ ok: true, state: 'incompatible' }), {
    profile: 'web; echo unsafe', packageName: '@bad/package && unsafe',
  })
  assert.equal(incompatible.badge, 'recovery')
  assert.match(incompatible.summary, /危险模块和所有 Profile 写操作已关闭/)
  assert.equal(incompatible.updateCommand, 'dsh plugin --profile web update @harness-flow/dsh-flow-hub')
  assert.equal(incompatible.removeCommand, 'dsh plugin --profile web remove @harness-flow/dsh-flow-hub')
})

test('safe Bootstrap keeps recovery local and full data calls behind the compatibility gate', async () => {
  const bootstrap = await readFile('src/client/bootstrap.tsx', 'utf8')
  const policy = await readFile('src/bootstrap-policy.ts', 'utf8')
  const fullUi = await readFile('src/client/index.tsx', 'utf8')
  assert.match(bootstrap, /decideBootstrapRuntime\(bootstrap, failed\)/)
  assert.match(bootstrap, /if \(runtime\.loadFullUi && bootstrap !== null\)/)
  assert.match(policy, /dsh plugin --profile \$\{profile\} remove \$\{packageName\}/)
  assert.match(bootstrap, /复制更新命令/)
  assert.match(bootstrap, /复制救援命令/)
  assert.match(bootstrap, /packageName: bootstrap\?\.hubPackageName/)
  assert.doesNotMatch(bootstrap, /packageName: bootstrap\?\.packageName/)
  assert.match(bootstrap, /不会由页面自动执行/)
  assert.match(bootstrap, /aria-live="polite"/)
  assert.match(bootstrap, /Registry Schema/)
  assert.match(bootstrap, /Flow Schema/)
  assert.doesNotMatch(bootstrap, /api\/registry|api\/profiles|api\/tasks|api\/flows|api\/plan|api\/plugin|api\/rollback/)
  assert.doesNotMatch(bootstrap, /window\.open|location\.(?:assign|replace)|<a\s/i)
  assert.doesNotMatch(fullUi, /api<BootstrapResponse>\('bootstrap'\)/)
})

test('hosted workers retain real DSH evidence for read-only, incompatible and rescue modes', async () => {
  const workflow = await readFile('.github/workflows/registry.yml', 'utf8')
  const verifier = await readFile('scripts/verify-bootstrap-compatibility.mjs', 'utf8')
  assert.match(workflow, /Verify read-only, incompatible, update guidance and CLI rescue modes/)
  assert.match(workflow, /pnpm run ui:verify-bootstrap-compatibility/)
  assert.match(workflow, /m2-bootstrap-recovery-modes-2026-08-16\.json/)
  assert.match(verifier, /startWeb\(cli, home, '0\.1\.0-rc\.7'\)/)
  assert.match(verifier, /runtimeMode: 'read-only'/)
  assert.match(verifier, /hubPackageName !== '@harness-flow\/dsh-flow-hub'/)
  assert.match(verifier, /CLI rescue remove/)
  assert.match(verifier, /CLI rescue reinstall/)
})
