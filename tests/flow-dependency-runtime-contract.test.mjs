import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const script = await readFile(new URL('../scripts/verify-flow-dependency-runtime.mjs', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../.github/workflows/registry.yml', import.meta.url), 'utf8')

test('third-party runtime verifier is hosted-only, secret-minimized, exact, and recoverable', () => {
  assert.match(script, /GITHUB_ACTIONS !== 'true'/)
  assert.match(script, /DSH_THIRD_PARTY_RUNTIME_ALLOWED !== 'hosted-ephemeral'/)
  assert.match(script, /safeEnvironment/)
  assert.doesNotMatch(script, /env:\s*\{\s*\.\.\.process\.env/)
  assert.match(script, /--ignore-scripts/)
  assert.match(script, /safePackageSlug/)
  assert.match(script, /home === undefined/)
  assert.match(script, /--dump-config/)
  assert.match(script, /post-remove-profile-health/)
  assert.match(script, /outboundNetworkBlocked: false/)
  assert.match(script, /not a security certification/)
})

test('runtime job runs only after a main push and uploads evidence even on failure', () => {
  assert.match(workflow, /flow-dependency-runtime:/)
  assert.match(workflow, /github\.event_name == 'push'/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /DSH_THIRD_PARTY_RUNTIME_ALLOWED: hosted-ephemeral/)
  assert.match(workflow, /if: always\(\)/)
})
