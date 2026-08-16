import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialNames, telemetryPolicy } from '../lib/privacy.js'
import { createInstallPlan } from '../lib/transaction.js'

test('credential declarations accept names only and telemetry is disabled', () => {
  assert.deepEqual(credentialNames(['FLOW_TOKEN', 'API_KEY', 'FLOW_TOKEN']), ['API_KEY', 'FLOW_TOKEN'])
  for (const value of ['sk-secret-value-123456789', 'name=value', 'lowercase', 'PRIVATE KEY']) {
    assert.throws(() => credentialNames([value]), /credential-name-required/)
    assert.throws(() => createInstallPlan({
      action: 'add', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: '@harness-flow/hello-bundle@0.0.1', credentials: [value],
    }), /credential-name-required/)
  }
  assert.deepEqual(telemetryPolicy, { enabled: false, persistedCredentialFields: [] })
})
