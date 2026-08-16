import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const evidence = JSON.parse(await readFile(new URL('../evidence/m3-flow-empty-environment-cross-platform-2026-08-17.json', import.meta.url), 'utf8'))
const expected = new Map([
  ['coding-expert', ['dsh-openwolf@0.9.1']],
  ['research-expert', ['dsh-plugin-writing-guard@0.9.2', 'dsh-science-workbench@0.1.1']],
  ['ui-design-studio', ['@anionex/dsh-vision-toolkit@0.1.8']],
])

test('cross-platform empty-environment evidence proves three signed test Flow transactions without changing public state', () => {
  assert.equal(evidence.baseCommit, '31b799f1149600414790fd1b8ada6447c47b019a')
  assert.match(evidence.run, /actions\/runs\/31979524263$/)
  for (const os of ['win32', 'linux']) {
    const platform = evidence.platforms[os]
    assert.equal(platform.status, 'passed')
    assert.equal(platform.dsh, '0.1.0-rc.6')
    assert.deepEqual(Object.keys(platform.flows).sort(), [...expected.keys()].sort())
    for (const [id, packages] of expected) {
      const flow = platform.flows[id]
      assert.equal(flow.status, 'passed')
      assert.equal(flow.variant, 'safe')
      assert.deepEqual(flow.packages, [...packages].sort())
      assert.deepEqual(flow.transactionSteps, ['preflight', 'initialize-profile', 'snapshot', 'staging', 'install-packages', 'dump-config', 'boot-smoke', 'commit', 'health', 'write-stack-lock'])
      assert.ok(flow.validationTasks.length >= 3)
      assert.match(flow.stackLock.flowDigest, /^sha256:[0-9a-f]{64}$/)
      assert.match(flow.stackLock.configDigest, /^sha256:[0-9a-f]{64}$/)
    }
  }
  assert.equal(evidence.isolation.privateKeyPersisted, false)
  assert.equal(evidence.isolation.repositorySecretsForwarded, false)
  assert.equal(evidence.isolation.userContentUsed, false)
  assert.equal(evidence.isolation.privatePathsRecorded, false)
  assert.equal(evidence.decision.hostedEmptyEnvironmentGate, 'passed-cross-platform')
  assert.equal(evidence.decision.publicRegistryVerificationStateChanged, false)
  assert.equal(evidence.decision.flowExecutableStateChanged, false)
  assert.equal(evidence.decision.publicM3ExitGate, 'open')
})
