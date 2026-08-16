import { createHash, sign, verify } from 'node:crypto'

export interface RegistrySignatureEnvelope {
  schemaVersion: number
  algorithm: string
  keyId: string
  registryVersion: string
  registrySha256: string
  createdAt: string
  expiresAt: string
  signature: string
}

export interface RegistryRevocations {
  revokedKeyIds: string[]
  revokedRegistryVersions: string[]
}

export type RegistryTrustReason =
  | 'verified' | 'missing-signature-artifacts' | 'invalid-signature-artifacts'
  | 'invalid-registry-json' | 'unsupported-algorithm' | 'version-mismatch' | 'hash-mismatch'
  | 'key-revoked' | 'registry-revoked' | 'invalid-validity-window' | 'not-yet-valid'
  | 'expired' | 'invalid-signature'

export interface RegistryTrust {
  status: 'verified' | 'missing' | 'invalid'
  reason: RegistryTrustReason
  keyId?: string
  createdAt?: string
  expiresAt?: string
  allowRecommendations: boolean
  allowInstallPlans: boolean
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function signRegistry(registryText: string, privateKey: string | Buffer, options: { keyId: string, createdAt: string | Date, expiresAt: string | Date }): RegistrySignatureEnvelope {
  const registry = JSON.parse(registryText) as { registryVersion: string }
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

export function verifyRegistrySignature(
  registryText: string,
  envelope: RegistrySignatureEnvelope,
  publicKey: string | Buffer,
  options: { revocations?: RegistryRevocations, now?: string | number | Date } = {},
): { ok: boolean, reason: RegistryTrustReason } {
  const now = new Date(options.now ?? Date.now())
  const revocations = options.revocations ?? { revokedKeyIds: [], revokedRegistryVersions: [] }
  let registry: { registryVersion?: unknown }
  try {
    registry = JSON.parse(registryText) as { registryVersion?: unknown }
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
  if (![now, createdAt, expiresAt].every(value => Number.isFinite(value.valueOf())) || expiresAt <= createdAt) return { ok: false, reason: 'invalid-validity-window' }
  if (now < createdAt) return { ok: false, reason: 'not-yet-valid' }
  if (now >= expiresAt) return { ok: false, reason: 'expired' }
  try {
    const valid = verify(null, Buffer.from(registryText), publicKey, Buffer.from(envelope.signature, 'base64'))
    return valid ? { ok: true, reason: 'verified' } : { ok: false, reason: 'invalid-signature' }
  } catch {
    return { ok: false, reason: 'invalid-signature' }
  }
}

export function evaluateRegistryTrust(input: {
  registryText: string
  envelope?: RegistrySignatureEnvelope
  publicKey?: string | Buffer
  revocations?: RegistryRevocations
  now?: string | number | Date
}): RegistryTrust {
  if (input.envelope === undefined && input.publicKey === undefined) {
    return { status: 'missing', reason: 'missing-signature-artifacts', allowRecommendations: false, allowInstallPlans: false }
  }
  if (input.envelope === undefined || input.publicKey === undefined || input.revocations === undefined) {
    return { status: 'invalid', reason: 'invalid-signature-artifacts', allowRecommendations: false, allowInstallPlans: false }
  }
  const result = verifyRegistrySignature(input.registryText, input.envelope, input.publicKey, { revocations: input.revocations, now: input.now })
  return {
    status: result.ok ? 'verified' : 'invalid',
    reason: result.reason,
    keyId: input.envelope.keyId,
    createdAt: input.envelope.createdAt,
    expiresAt: input.envelope.expiresAt,
    allowRecommendations: result.ok,
    allowInstallPlans: result.ok,
  }
}
