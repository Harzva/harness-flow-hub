import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const evidence = JSON.parse(await readFile(new URL('../evidence/m3-flow-capability-workflows-cross-platform-2026-08-17.json', import.meta.url), 'utf8'))

test('cross-platform Flow capability evidence keeps partial UI proof fail-closed', () => {
  assert.equal(evidence.platforms.win32.status, 'passed')
  assert.equal(evidence.platforms.linux.status, 'passed')
  for (const platform of Object.values(evidence.platforms)) {
    assert.equal(platform.coding.package, 'dsh-openwolf@0.9.1')
    assert.equal(platform.coding.finalTestsPassed, true)
    assert.equal(platform.ui.package, '@anionex/dsh-vision-toolkit@0.1.8')
    assert.equal(platform.ui.nativeToolDefinitionsExecuted, true)
    assert.equal(platform.ui.officialToolRuntimePipeline, true)
    assert.equal(platform.ui.agentScopedSkillActivation, true)
    assert.equal(platform.ui.toolsHiddenBeforeSkill, true)
    assert.equal(platform.ui.activationBootstrapHiddenAfterSkill, true)
    assert.equal(platform.ui.externalVisionApiCalled, false)
    assert.ok(platform.ui.currentRunner.finalDifferencePct < platform.ui.currentRunner.initialDifferencePct)
  }
  assert.equal(evidence.isolation.userContentUsed, false)
  assert.equal(evidence.isolation.credentialsConfigured, false)
  assert.equal(evidence.capabilityDecision.registryVerificationStateChanged, false)
  assert.equal(evidence.capabilityDecision.flowExecutableStateChanged, false)
  assert.match(evidence.capabilityDecision.uiDesignStudio, /agent-scoped-skill-and-tool-runtime-workflow-passed-cross-platform/)
})
