import { createHash, sign, verify } from 'node:crypto'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function signRegistry(registryText, privateKey, options) {
  const registry = JSON.parse(registryText)
  const createdAt = new Date(options.createdAt)
  const expiresAt = new Date(options.expiresAt)
  if (!Number.isFinite(createdAt.valueOf()) || !Number.isFinite(expiresAt.valueOf()) || expiresAt <= createdAt) {
    throw new Error('signature expiry must be later than creation time')
  }
  return {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    keyId: options.keyId,
    registryVersion: registry.registryVersion,
    registrySha256: sha256(registryText),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    signature: sign(null, Buffer.from(registryText), privateKey).toString('base64'),
  }
}

export function verifyRegistrySignature(registryText, envelope, publicKey, options = {}) {
  const now = new Date(options.now ?? Date.now())
  const revocations = options.revocations ?? { revokedKeyIds: [], revokedRegistryVersions: [] }
  let registry
  try {
    registry = JSON.parse(registryText)
  } catch {
    return { ok: false, reason: 'invalid-registry-json' }
  }
  if (envelope.algorithm !== 'Ed25519') return { ok: false, reason: 'unsupported-algorithm' }
  if (envelope.registryVersion !== registry.registryVersion) return { ok: false, reason: 'version-mismatch' }
  if (envelope.registrySha256 !== sha256(registryText)) return { ok: false, reason: 'hash-mismatch' }
  if (revocations.revokedKeyIds.includes(envelope.keyId)) return { ok: false, reason: 'key-revoked' }
  if (revocations.revokedRegistryVersions.includes(envelope.registryVersion)) return { ok: false, reason: 'registry-revoked' }
  const createdAt = new Date(envelope.createdAt)
  const expiresAt = new Date(envelope.expiresAt)
  if (![now, createdAt, expiresAt].every(value => Number.isFinite(value.valueOf())) || expiresAt <= createdAt) {
    return { ok: false, reason: 'invalid-validity-window' }
  }
  if (now < createdAt) return { ok: false, reason: 'not-yet-valid' }
  if (now >= expiresAt) return { ok: false, reason: 'expired' }
  const valid = verify(null, Buffer.from(registryText), publicKey, Buffer.from(envelope.signature, 'base64'))
  return valid ? { ok: true, reason: 'verified' } : { ok: false, reason: 'invalid-signature' }
}
