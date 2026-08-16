import { createHash } from 'node:crypto'

export type FlowVariantName = 'lite' | 'standard' | 'local' | 'safe'

interface FlowPlugin {
  package: string
  range: string
  relationship: 'required' | 'recommended' | 'alternative' | 'conflict'
  alternativeGroup?: string
}

interface FlowVariant {
  role: string
  boundaries: string[]
  model: { recommended: string, constraints: string[] }
  skills: Array<{ id: string, purpose: string }>
  plugins: FlowPlugin[]
  memory: Array<{ id: string, scope: string, retention: string }>
  workflows: Array<{ id: string, goal: string, steps: string[] }>
  permissionsPreset: string
  uiExtensions: string[]
  defaults: Record<string, unknown>
  platforms: Array<'win32' | 'linux' | 'darwin'>
  credentials: string[]
}

export interface HarnessFlow {
  schemaVersion: 1
  id: string
  name: string
  version: string
  category: 'domain-expert' | 'task-expert' | 'work-environment'
  goal: string
  targetUsers: string[]
  expectedOutputs: string[]
  variants: Partial<Record<FlowVariantName, FlowVariant>>
  validation: Array<{ id: string, kind: string, description: string }>
  uninstall: string[]
}

export interface RegistryPlugin {
  package: string
  version: string
  source: { kind: string, spec: string, integrity?: string, commit?: string }
  verification: { state: 'unknown' | 'unverified' | 'passed' | 'failed' | 'stale' }
}

export interface StackLock {
  schemaVersion: 1
  generatedAt: string
  dshVersion: string
  platform: { os: 'win32' | 'linux' | 'darwin', arch: string, node: string }
  profile: string
  flow: { id: string, version: string, variant: FlowVariantName, digest: string }
  packages: Array<{ package: string, version: string, source: string, integrity: string, commit?: string }>
  configDigest: string
  validations: Array<{ id: string, status: 'skipped', evidence: string }>
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalized(item)]))
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value))
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function safeProfile(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`invalid-stack-profile:${value}`)
  return value
}

function selectedPlugins(variant: FlowVariant): FlowPlugin[] {
  const conflicts = new Set(variant.plugins.filter(item => item.relationship === 'conflict').map(item => item.package))
  const selected = variant.plugins.filter(item => item.relationship === 'required' || item.relationship === 'recommended')
  if (selected.some(item => conflicts.has(item.package))) throw new Error('flow-plugin-conflict')
  if (variant.plugins.some(item => item.relationship === 'alternative')) throw new Error('flow-alternative-requires-explicit-selection')
  return selected
}

export function compileStackPreview(flow: HarnessFlow, variantName: FlowVariantName, registryPlugins: RegistryPlugin[], options: {
  generatedAt: string
  dshVersion: string
  platform: 'win32' | 'linux' | 'darwin'
  arch: string
  node: string
  profile?: string
}): StackLock {
  const variant = flow.variants[variantName]
  if (variant === undefined) throw new Error(`flow-variant-unavailable:${variantName}`)
  if (!variant.platforms.includes(options.platform)) throw new Error(`flow-platform-unsupported:${options.platform}`)
  if (!Number.isFinite(Date.parse(options.generatedAt))) throw new Error('invalid-stack-generated-at')
  const packages = selectedPlugins(variant).map(requirement => {
    const candidate = registryPlugins.find(item => item.package === requirement.package && item.version === requirement.range)
    if (candidate === undefined) throw new Error(`flow-package-unresolved:${requirement.package}@${requirement.range}`)
    if (candidate.verification.state === 'failed' || candidate.verification.state === 'stale') throw new Error(`flow-package-not-eligible:${requirement.package}:${candidate.verification.state}`)
    const integrity = candidate.source.integrity ?? (candidate.source.commit === undefined ? null : `commit:${candidate.source.commit}`)
    if (integrity === null) throw new Error(`flow-package-integrity-missing:${requirement.package}`)
    return {
      package: candidate.package,
      version: candidate.version,
      source: candidate.source.spec,
      integrity,
      ...(candidate.source.commit === undefined ? {} : { commit: candidate.source.commit }),
    }
  }).sort((left, right) => left.package.localeCompare(right.package))
  const profile = safeProfile(options.profile ?? `flow-${flow.id}-${variantName}`)
  const config = {
    role: variant.role,
    boundaries: variant.boundaries,
    model: variant.model,
    skills: variant.skills,
    memory: variant.memory,
    workflows: variant.workflows,
    permissionsPreset: variant.permissionsPreset,
    uiExtensions: variant.uiExtensions,
    defaults: variant.defaults,
    credentials: variant.credentials,
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date(options.generatedAt).toISOString(),
    dshVersion: options.dshVersion,
    platform: { os: options.platform, arch: options.arch, node: options.node },
    profile,
    flow: { id: flow.id, version: flow.version, variant: variantName, digest: sha256Digest(flow) },
    packages,
    configDigest: sha256Digest(config),
    validations: flow.validation.map(task => ({ id: task.id, status: 'skipped', evidence: 'preview-only; run after Profile installation' })),
  }
}

export function compareFlowVariants(flow: HarnessFlow, from: FlowVariantName, to: FlowVariantName): { added: string[], removed: string[], shared: string[] } {
  const left = flow.variants[from]
  const right = flow.variants[to]
  if (left === undefined || right === undefined) throw new Error('flow-variant-comparison-unavailable')
  const leftPackages = new Set(selectedPlugins(left).map(item => item.package))
  const rightPackages = new Set(selectedPlugins(right).map(item => item.package))
  return {
    added: [...rightPackages].filter(item => !leftPackages.has(item)).sort(),
    removed: [...leftPackages].filter(item => !rightPackages.has(item)).sort(),
    shared: [...leftPackages].filter(item => rightPackages.has(item)).sort(),
  }
}
