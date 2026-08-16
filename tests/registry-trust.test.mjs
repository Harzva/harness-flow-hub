import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { evaluateRegistryTrust, signRegistry } from '../lib/registry-trust.js'

const registryText = JSON.stringify({ schemaVersion: 1, registryVersion: 'test-v1', plugins: [], flows: [] })
const now = '2026-08-17T00:00:00.000Z'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const envelope = signRegistry(registryText, privateKey, {
  keyId: 'test-key', createdAt: '2026-08-16T00:00:00.000Z', expiresAt: '2026-08-18T00:00:00.000Z',
})
const revocations = { revokedKeyIds: [], revokedRegistryVersions: [] }

test('runtime Registry trust permits plans only after complete Ed25519 verification', () => {
  const verified = evaluateRegistryTrust({ registryText, envelope, publicKey, revocations, now })
  assert.deepEqual({ status: verified.status, reason: verified.reason, recommend: verified.allowRecommendations, install: verified.allowInstallPlans }, {
    status: 'verified', reason: 'verified', recommend: true, install: true,
  })

  const failures = [
    evaluateRegistryTrust({ registryText, now }),
    evaluateRegistryTrust({ registryText, envelope, now }),
    evaluateRegistryTrust({ registryText: `${registryText} `, envelope, publicKey, revocations, now }),
    evaluateRegistryTrust({ registryText, envelope, publicKey, revocations, now: '2026-08-19T00:00:00.000Z' }),
    evaluateRegistryTrust({ registryText, envelope, publicKey, revocations: { ...revocations, revokedKeyIds: ['test-key'] }, now }),
    evaluateRegistryTrust({ registryText, envelope, publicKey, revocations: { ...revocations, revokedRegistryVersions: ['test-v1'] }, now }),
  ]
  assert.deepEqual(failures.map(item => item.reason), [
    'missing-signature-artifacts', 'invalid-signature-artifacts', 'hash-mismatch', 'expired', 'key-revoked', 'registry-revoked',
  ])
  assert.ok(failures.every(item => !item.allowRecommendations && !item.allowInstallPlans))
})
