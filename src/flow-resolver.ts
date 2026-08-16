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

function profileTemplate(variant: FlowVariant): 'headless' | 'web' {
  const template = variant.defaults.profileTemplate
  if (template !== 'headless' && template !== 'web') throw new Error('flow-profile-template-required')
  return template
}

function compareSemver(left: string, right: string): number | null {
  const parse = (value: string): { core: [number, number, number], pre: Array<number | string> } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    if (match === null) return null
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number],
      pre: match[4] === undefined ? [] : match[4].split('.').map(item => /^\d+$/.test(item) ? Number(item) : item),
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    const av = a.core[index]!
    const bv = b.core[index]!
    if (av !== bv) return av < bv ? -1 : 1
  }
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : (a.pre.length === 0 ? 1 : -1)
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const av = a.pre[index]
    const bv = b.pre[index]
    if (av === undefined || bv === undefined) return av === bv ? 0 : (av === undefined ? -1 : 1)
    if (av === bv) continue
    if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1
    if (typeof av === 'number') return -1
    if (typeof bv === 'number') return 1
    return av < bv ? -1 : 1
  }
  return 0
}

function supportsDshVersion(range: string, version: string): boolean {
  const clauses = range.trim().split(/\s+/)
  if (clauses.length === 0 || range.includes('||')) return false
  return clauses.every(clause => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(clause)
    if (match === null) return false
    const compared = compareSemver(version, match[2]!)
    if (compared === null) return false
    if (match[1] === '>=') return compared >= 0
    if (match[1] === '<=') return compared <= 0
    if (match[1] === '>') return compared > 0
    if (match[1] === '<') return compared < 0
    return compared === 0
  })
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
      credentials: [...(candidate.credentials ?? [])].sort(),
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
  const credentials = [...new Set([...variant.credentials, ...operations.flatMap(item => item.credentials)])].sort()
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
