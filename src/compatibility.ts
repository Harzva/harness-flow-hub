import { satisfies, valid, validRange } from 'semver'

export type CompatibilityState = 'compatible' | 'unknown' | 'incompatible'
export type CompatibilityDimensionName = 'dsh' | 'hub' | 'registrySchema' | 'flowSchema'

export interface CompatibilityDimension {
  actual: string | null
  supported: string
  state: CompatibilityState
  reason: string
}

export interface CompatibilitySnapshot {
  overall: CompatibilityState
  dimensions: Record<CompatibilityDimensionName, CompatibilityDimension>
}

export interface CompatibilityInput {
  dshVersion: string | null
  hubVersion: string | null
  registrySchemaVersion: unknown
  flowSchemaVersions: unknown
}

export const SUPPORTED_DSH_RANGE = '>=0.1.0-rc.6 <0.2.0'
export const SUPPORTED_HUB_RANGE = '>=0.0.2-m0 <0.1.0'
export const SUPPORTED_REGISTRY_SCHEMA = 1
export const SUPPORTED_FLOW_SCHEMA = 1

function versionDimension(actual: string | null, supported: string): CompatibilityDimension {
  if (actual === null || actual.trim() === '') return { actual: null, supported, state: 'unknown', reason: 'version-unavailable' }
  if (valid(actual) === null || validRange(supported) === null) return { actual, supported, state: 'incompatible', reason: 'invalid-semver' }
  return satisfies(actual, supported, { includePrerelease: true })
    ? { actual, supported, state: 'compatible', reason: 'range-satisfied' }
    : { actual, supported, state: 'incompatible', reason: 'range-not-satisfied' }
}

export function classifyDshVersion(actual: string | null): CompatibilityState {
  return versionDimension(actual, SUPPORTED_DSH_RANGE).state
}

function schemaDimension(actual: unknown, supported: number): CompatibilityDimension {
  const supportedLabel = `${supported}.x`
  if (actual === null || actual === undefined) return { actual: null, supported: supportedLabel, state: 'unknown', reason: 'schema-version-unavailable' }
  if (!Number.isSafeInteger(actual) || Number(actual) < 1) return { actual: String(actual), supported: supportedLabel, state: 'incompatible', reason: 'invalid-schema-version' }
  return actual === supported
    ? { actual: String(actual), supported: supportedLabel, state: 'compatible', reason: 'schema-supported' }
    : { actual: String(actual), supported: supportedLabel, state: 'incompatible', reason: 'schema-not-supported' }
}

function flowSchemaDimension(actual: unknown, supported: number): CompatibilityDimension {
  if (!Array.isArray(actual) || actual.length === 0) return { actual: null, supported: `${supported}.x`, state: 'unknown', reason: 'flow-schema-version-unavailable' }
  const invalid = actual.find(value => !Number.isSafeInteger(value) || Number(value) < 1)
  if (invalid !== undefined) return { actual: actual.map(String).join(','), supported: `${supported}.x`, state: 'incompatible', reason: 'invalid-flow-schema-version' }
  const versions = [...new Set(actual as number[])].sort((a, b) => a - b)
  const label = versions.join(',')
  return versions.length === 1 && versions[0] === supported
    ? { actual: label, supported: `${supported}.x`, state: 'compatible', reason: 'all-flow-schemas-supported' }
    : { actual: label, supported: `${supported}.x`, state: 'incompatible', reason: 'flow-schema-not-supported' }
}

export function evaluateCompatibility(input: CompatibilityInput): CompatibilitySnapshot {
  const dimensions = {
    dsh: versionDimension(input.dshVersion, SUPPORTED_DSH_RANGE),
    hub: versionDimension(input.hubVersion, SUPPORTED_HUB_RANGE),
    registrySchema: schemaDimension(input.registrySchemaVersion, SUPPORTED_REGISTRY_SCHEMA),
    flowSchema: flowSchemaDimension(input.flowSchemaVersions, SUPPORTED_FLOW_SCHEMA),
  }
  const states = Object.values(dimensions).map(dimension => dimension.state)
  const overall: CompatibilityState = states.includes('incompatible') ? 'incompatible' : states.includes('unknown') ? 'unknown' : 'compatible'
  return { overall, dimensions }
}
