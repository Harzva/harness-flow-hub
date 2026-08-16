import { satisfies, valid, validRange } from 'semver'

const allowedStates = new Set(['compatible', 'unknown', 'incompatible'])
const allowedVerifications = new Set(['full-lifecycle', 'safe-recovery'])

export function validateDshMatrixConfig(config) {
  if (config?.schemaVersion !== 1 || config.package !== '@deepseek-ai/dsh') throw new Error('invalid-dsh-matrix-header')
  if (validRange(config.supportedRange) === null) throw new Error('invalid-dsh-supported-range')
  if (!Array.isArray(config.platforms) || config.platforms.length === 0) throw new Error('dsh-matrix-platforms-required')
  if (!Array.isArray(config.entries) || config.entries.length < 2) throw new Error('dsh-matrix-entries-required')
  const roles = new Set()
  const versions = new Set()
  for (const entry of config.entries) {
    if (typeof entry.role !== 'string' || !/^[a-z0-9-]+$/.test(entry.role) || roles.has(entry.role)) throw new Error(`invalid-or-duplicate-matrix-role:${entry.role}`)
    if (valid(entry.version) === null || versions.has(entry.version)) throw new Error(`invalid-or-duplicate-matrix-version:${entry.version}`)
    if (!allowedStates.has(entry.expected) || !allowedVerifications.has(entry.verification)) throw new Error(`invalid-matrix-expectation:${entry.role}`)
    if (entry.verification === 'full-lifecycle' && entry.expected !== 'compatible') throw new Error(`full-lifecycle-entry-must-be-compatible:${entry.role}`)
    roles.add(entry.role)
    versions.add(entry.version)
  }
  if (!config.entries.some(entry => entry.role === 'current' && entry.expected === 'compatible')) throw new Error('compatible-current-entry-required')
  if (!config.entries.some(entry => entry.role === 'previous')) throw new Error('previous-entry-required')
  return config
}

export function buildDshCiMatrix(configInput, distTags = {}) {
  const config = validateDshMatrixConfig(configInput)
  const entries = config.entries.map(entry => ({ ...entry }))
  const configuredVersions = new Set(entries.map(entry => entry.version))
  for (const tag of ['latest', 'next']) {
    const version = distTags[tag]
    if (typeof version !== 'string' || valid(version) === null || configuredVersions.has(version)) continue
    const expected = satisfies(version, config.supportedRange, { includePrerelease: true }) ? 'unknown' : 'incompatible'
    entries.push({ role: `candidate-${tag}`, version, expected, verification: 'safe-recovery' })
    configuredVersions.add(version)
  }
  return {
    include: entries.flatMap(entry => config.platforms.map(os => ({ os, ...entry }))),
  }
}
