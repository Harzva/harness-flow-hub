import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const evidence = JSON.parse(await readFile(new URL('../evidence/m3-flow-dependency-runtime-cross-platform-2026-08-17.json', import.meta.url), 'utf8'))

test('cross-platform runtime evidence keeps bounded boot separate from Registry verification', () => {
  assert.equal(evidence.platforms.win32.status, 'passed')
  assert.equal(evidence.platforms.linux.status, 'passed')
  assert.equal(evidence.platforms.win32.packages.length, 7)
  assert.equal(evidence.platforms.linux.packages.length, 7)
  assert.ok(evidence.platforms.win32.packages.some(item => item.package === 'dsh-openwolf' && item.probe === 'process-remained-healthy-without-workspace-tool-action'))
  assert.ok(evidence.platforms.linux.packages.some(item => item.package === '@anionex/dsh-vision-toolkit' && item.probe === 'read-only-settings-route'))
  assert.equal(evidence.checks.completeFlowWorkflowExecuted, false)
  assert.equal(evidence.checks.securityCertificationClaimed, false)
  assert.equal(evidence.registryDecision.verificationStateChanged, false)
  assert.equal(evidence.result, 'passed-with-scope-limit')
})
