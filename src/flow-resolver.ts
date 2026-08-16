import { createHash } from 'node:crypto'
import { maxSatisfying, satisfies, valid, validRange } from 'semver'
import { credentialNames } from './privacy.js'

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
  compatibility?: { dsh: string }
  platforms?: string[]
  license?: string | null
  lifecycleScripts?: Record<string, string>
  permissions?: string[]
  credentials?: string[]
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

export interface FlowInstallPlan {
  schemaVersion: 1
  id: string
  createdAt: string
  action: 'install-flow'
  profile: { name: string, isolation: 'new', template: 'headless' | 'web' }
  flow: { id: string, version: string, variant: FlowVariantName, digest: string }
  stack: StackLock
  operations: Array<{
    order: number
    action: 'add'
    package: string
    version: string
    source: { kind: string, spec: string, integrity: string, commit?: string }
    verification: RegistryPlugin['verification']['state']
    lifecycleScripts: string[]
    permissions: string[]
    credentials: string[]
  }>
  risk: {
    registrySignature: 'verified' | 'unverified'
    lifecycleScriptsDisabled: true
    permissionsPreset: string
    permissions: string[]
    credentials: string[]
  }
  steps: Array<'preflight' | 'initialize-profile' | 'snapshot' | 'staging' | 'install-packages' | 'dump-config' | 'boot-smoke' | 'commit' | 'health' | 'write-stack-lock'>
  executable: boolean
  blockers: string[]
}

export interface FlowMigrationPreview {
  schemaVersion: 1
  id: string
  createdAt: string
  action: 'preview-flow-update'
  profile: string
  current: StackLock
  target: StackLock
  changes: {
    added: StackLock['packages']
    removed: StackLock['packages']
    updated: Array<{ package: string, from: StackLock['packages'][number], to: StackLock['packages'][number] }>
    relocked: Array<{ package: string, from: StackLock['packages'][number], to: StackLock['packages'][number] }>
    configChanged: boolean
  }
  summary: { added: number, removed: number, updated: number, relocked: number, configChanged: boolean }
  requiresConfirmation: true
  mutatesProfile: false
}

interface ResolutionOptions {
  includeRecommended?: boolean
  alternatives?: Record<string, string>
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

function selectedPlugins(variant: FlowVariant, options: ResolutionOptions = {}): FlowPlugin[] {
  const conflicts = new Set(variant.plugins.filter(item => item.relationship === 'conflict').map(item => item.package))
  const selected = variant.plugins.filter(item => item.relationship === 'required' || (item.relationship === 'recommended' && options.includeRecommended !== false))
  const alternativeGroups = new Map<string, FlowPlugin[]>()
  for (const item of variant.plugins.filter(candidate => candidate.relationship === 'alternative')) {
    if (item.alternativeGroup === undefined) throw new Error(`flow-alternative-group-missing:${item.package}`)
    alternativeGroups.set(item.alternativeGroup, [...(alternativeGroups.get(item.alternativeGroup) ?? []), item])
  }
  for (const [group, candidates] of alternativeGroups) {
    const choice = options.alternatives?.[group]
    if (choice === undefined) throw new Error(`flow-alternative-requires-explicit-selection:${group}`)
    const selectedAlternative = candidates.find(item => item.package === choice)
    if (selectedAlternative === undefined) throw new Error(`flow-alternative-invalid-selection:${group}:${choice}`)
    selected.push(selectedAlternative)
  }
  if (selected.some(item => conflicts.has(item.package))) throw new Error('flow-plugin-conflict')
  return selected.sort((left, right) => left.package.localeCompare(right.package))
}

function resolvePlugin(requirement: FlowPlugin, registryPlugins: RegistryPlugin[]): RegistryPlugin {
  if (validRange(requirement.range) === null) throw new Error(`flow-version-range-invalid:${requirement.package}@${requirement.range}`)
  const named = registryPlugins.filter(item => item.package === requirement.package && valid(item.version) !== null)
  const matching = named.filter(item => satisfies(item.version, requirement.range))
  const eligible = matching.filter(item => item.verification.state !== 'failed' && item.verification.state !== 'stale')
  const selectedVersion = maxSatisfying(eligible.map(item => item.version), requirement.range)
  if (selectedVersion === null) {
    if (matching.length > 0) throw new Error(`flow-package-not-eligible:${requirement.package}:${[...new Set(matching.map(item => item.verification.state))].sort().join(',')}`)
    throw new Error(`flow-package-unresolved:${requirement.package}@${requirement.range}`)
  }
  const candidates = eligible.filter(item => item.version === selectedVersion)
  if (candidates.length !== 1) throw new Error(`flow-package-ambiguous:${requirement.package}@${selectedVersion}`)
  return candidates[0]!
}

export function compileStackPreview(flow: HarnessFlow, variantName: FlowVariantName, registryPlugins: RegistryPlugin[], options: {
  generatedAt: string
  dshVersion: string
  platform: 'win32' | 'linux' | 'darwin'
  arch: string
  node: string
  profile?: string
  includeRecommended?: boolean
  alternatives?: Record<string, string>
}): StackLock {
  const variant = flow.variants[variantName]
  if (variant === undefined) throw new Error(`flow-variant-unavailable:${variantName}`)
  if (!variant.platforms.includes(options.platform)) throw new Error(`flow-platform-unsupported:${options.platform}`)
  if (!Number.isFinite(Date.parse(options.generatedAt))) throw new Error('invalid-stack-generated-at')
  const packages = selectedPlugins(variant, options).map(requirement => {
    const candidate = resolvePlugin(requirement, registryPlugins)
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
    credentials: credentialNames(variant.credentials),
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

function profileTemplate(variant: FlowVariant): 'headless' | 'web' {
  const template = variant.defaults.profileTemplate
  if (template !== 'headless' && template !== 'web') throw new Error('flow-profile-template-required')
  return template
}

function supportsDshVersion(range: string, version: string): boolean {
  return valid(version) !== null && validRange(range) !== null && satisfies(version, range)
}

export function compileFlowInstallPlan(flow: HarnessFlow, variantName: FlowVariantName, registryPlugins: RegistryPlugin[], options: {
  generatedAt: string
  dshVersion: string
  platform: 'win32' | 'linux' | 'darwin'
  arch: string
  node: string
  profile?: string
  includeRecommended?: boolean
  alternatives?: Record<string, string>
  registrySignature?: 'verified' | 'unverified'
}): FlowInstallPlan {
  const variant = flow.variants[variantName]
  if (variant === undefined) throw new Error(`flow-variant-unavailable:${variantName}`)
  const stack = compileStackPreview(flow, variantName, registryPlugins, options)
  const operations = stack.packages.map((item, index) => {
    const candidate = registryPlugins.find(plugin => plugin.package === item.package && plugin.version === item.version)
    if (candidate === undefined) throw new Error(`flow-package-unresolved:${item.package}@${item.version}`)
    return {
      order: index + 1,
      action: 'add' as const,
      package: item.package,
      version: item.version,
      source: { kind: candidate.source.kind, spec: candidate.source.spec, integrity: item.integrity, ...(item.commit === undefined ? {} : { commit: item.commit }) },
      verification: candidate.verification.state,
      lifecycleScripts: Object.keys(candidate.lifecycleScripts ?? {}).sort(),
      permissions: [...(candidate.permissions ?? [])].sort(),
      credentials: credentialNames(candidate.credentials ?? []),
    }
  })
  const signature = options.registrySignature ?? 'unverified'
  const blockers = new Set<string>()
  if (signature !== 'verified') blockers.add('registry-signature-not-verified')
  for (const operation of operations) {
    const candidate = registryPlugins.find(plugin => plugin.package === operation.package && plugin.version === operation.version)
    if (operation.verification !== 'passed') blockers.add(`plugin-not-verified:${operation.package}:${operation.verification}`)
    if (candidate?.compatibility?.dsh === undefined || candidate.compatibility.dsh === 'unknown') blockers.add(`plugin-dsh-compatibility-unknown:${operation.package}`)
    else if (!supportsDshVersion(candidate.compatibility.dsh, options.dshVersion)) blockers.add(`plugin-dsh-incompatible:${operation.package}:${candidate.compatibility.dsh}`)
    if (!(candidate?.platforms ?? []).includes(options.platform)) blockers.add(`plugin-platform-unverified:${operation.package}:${options.platform}`)
  }
  const permissions = [...new Set(operations.flatMap(item => item.permissions))].sort()
  const credentials = credentialNames([...variant.credentials, ...operations.flatMap(item => item.credentials)])
  const body = {
    schemaVersion: 1 as const,
    createdAt: stack.generatedAt,
    action: 'install-flow' as const,
    profile: { name: stack.profile, isolation: 'new' as const, template: profileTemplate(variant) },
    flow: stack.flow,
    stack,
    operations,
    risk: { registrySignature: signature, lifecycleScriptsDisabled: true as const, permissionsPreset: variant.permissionsPreset, permissions, credentials },
    steps: ['preflight', 'initialize-profile', 'snapshot', 'staging', 'install-packages', 'dump-config', 'boot-smoke', 'commit', 'health', 'write-stack-lock'] as FlowInstallPlan['steps'],
    executable: blockers.size === 0,
    blockers: [...blockers].sort(),
  }
  return { ...body, id: createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 24) }
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

export function compileFlowMigrationPreview(current: StackLock, flow: HarnessFlow, variantName: FlowVariantName, registryPlugins: RegistryPlugin[], options: {
  generatedAt: string
  dshVersion: string
  platform: 'win32' | 'linux' | 'darwin'
  arch: string
  node: string
  includeRecommended?: boolean
  alternatives?: Record<string, string>
}): FlowMigrationPreview {
  if (current.flow.id !== flow.id) throw new Error(`flow-migration-id-mismatch:${current.flow.id}:${flow.id}`)
  const target = compileStackPreview(flow, variantName, registryPlugins, { ...options, profile: current.profile })
  const currentByPackage = new Map(current.packages.map(item => [item.package, item]))
  const targetByPackage = new Map(target.packages.map(item => [item.package, item]))
  const added = target.packages.filter(item => !currentByPackage.has(item.package))
  const removed = current.packages.filter(item => !targetByPackage.has(item.package))
  const updated: FlowMigrationPreview['changes']['updated'] = []
  const relocked: FlowMigrationPreview['changes']['relocked'] = []
  for (const item of target.packages) {
    const before = currentByPackage.get(item.package)
    if (before === undefined) continue
    if (before.version !== item.version) updated.push({ package: item.package, from: before, to: item })
    else if (before.source !== item.source || before.integrity !== item.integrity || before.commit !== item.commit) relocked.push({ package: item.package, from: before, to: item })
  }
  const changes = { added, removed, updated, relocked, configChanged: current.configDigest !== target.configDigest }
  const body = {
    schemaVersion: 1 as const,
    createdAt: target.generatedAt,
    action: 'preview-flow-update' as const,
    profile: current.profile,
    current,
    target,
    changes,
    summary: { added: added.length, removed: removed.length, updated: updated.length, relocked: relocked.length, configChanged: changes.configChanged },
    requiresConfirmation: true as const,
    mutatesProfile: false as const,
  }
  return { ...body, id: createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 24) }
}
