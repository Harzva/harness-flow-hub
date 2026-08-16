import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

type BootstrapState = 'compatible' | 'unknown' | 'incompatible'
type PluginAction = 'add' | 'update' | 'remove'
type Action = PluginAction | 'rollback'
type View = 'home' | 'plugins' | 'flows' | 'profiles' | 'tasks'
type VerificationState = 'unknown' | 'unverified' | 'passed' | 'failed' | 'stale'

export interface CompatibilityDimension {
  actual: string | null
  supported: string
  state: BootstrapState
  reason: string
}

export interface CompatibilitySnapshot {
  overall: BootstrapState
  dimensions: Record<'dsh' | 'hub' | 'registrySchema' | 'flowSchema', CompatibilityDimension>
}

export interface BootstrapResponse {
  ok: boolean
  state: BootstrapState
  dshVersion: string | null
  hubVersion: string | null
  supported: string
  compatibility: CompatibilitySnapshot
  profile: string
  fixtureReady: boolean
  packageName: string
  hubPackageName: string
  testFailurePhase: string | null
}

interface ActionResponse {
  ok: boolean
  action?: Action
  planId?: string
  profile?: string
  phases?: Array<{ phase: string, status: 'passed' | 'failed' | 'skipped', detail?: string }>
  backupId?: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

interface InstallPlan {
  id: string
  action: PluginAction
  profile: string
  packageName: string
  expiresAt: string
  source: { kind: string, spec: string }
  artifact: { version: string, integrity: string, lifecycleScripts: string[] }
  requirements: { dshVersion: string, platforms: string[], network: { required: boolean, endpoint?: string } }
  risk: { lifecycleScriptsDisabled: boolean, permissions: string[], credentials: string[], verification: string, signature: string }
  phases: string[]
}

interface RollbackPlan {
  id: string
  action: 'rollback'
  profile: string
  backupId: string
  expiresAt: string
  requirements: { dshVersion: string, platforms: string[] }
  phases: string[]
}

type OperationPlan = InstallPlan | RollbackPlan

interface PluginRecord {
  id: string
  package: string
  version: string
  license: string | null
  lifecycleScripts: Record<string, string>
  permissions: string[]
  credentials: string[]
  source: { kind: string, spec: string, integrity?: string, commit?: string }
  verification: { state: VerificationState, verifiedAt?: string, platform?: string, environment?: { os: string, arch: string, node: string }, dshVersion?: string, evidence?: string[] }
}

interface Registry { registryVersion: string, plugins: PluginRecord[], flows: unknown[] }

function sourcePinning(plugin: PluginRecord): string {
  if (plugin.source.kind === 'github-sha' && /^[a-f0-9]{40}$/.test(plugin.source.commit ?? '') && plugin.source.spec.endsWith(`#${plugin.source.commit}`)) return `固定 commit · ${plugin.source.commit?.slice(0, 12)}`
  if (plugin.source.kind === 'npm' && plugin.source.spec === `${plugin.package}@${plugin.version}` && /^sha512-/.test(plugin.source.integrity ?? '')) return '精确 npm 版本 · integrity 已记录'
  return '浮动来源，禁止安装'
}
interface RegistryAvailability {
  catalog: 'bundled-snapshot' | 'unavailable'
  upstream: 'not-configured' | 'reachable' | 'unreachable'
  offlineReady: boolean
}
type FlowVariantName = 'lite' | 'standard' | 'local' | 'safe'
interface StackPreview {
  dshVersion: string
  platform: { os: string, arch: string, node: string }
  profile: string
  flow: { id: string, version: string, variant: FlowVariantName, digest: string }
  packages: Array<{ package: string, version: string, source: string, integrity: string }>
  configDigest: string
  validations: Array<{ id: string, status: 'skipped', evidence: string }>
}
interface FlowInstallPlanPreview {
  id: string
  createdAt: string
  profile: { name: string, isolation: 'new', template: 'headless' | 'web' }
  operations: Array<{
    order: number
    package: string
    version: string
    source: { kind: string, spec: string, integrity: string }
    verification: VerificationState
    lifecycleScripts: string[]
    permissions: string[]
    credentials: string[]
  }>
  risk: { registrySignature: 'verified' | 'unverified', lifecycleScriptsDisabled: true, permissionsPreset: string, permissions: string[], credentials: string[] }
  steps: string[]
  executable: boolean
  blockers: string[]
}
interface FlowVariantPreview {
  id: FlowVariantName
  role: string
  boundaries: string[]
  model: { recommended: string, constraints: string[] }
  skills: Array<{ id: string, purpose: string }>
  plugins: Array<{ package: string, range: string, relationship: string }>
  memory: Array<{ id: string, scope: string, retention: string }>
  workflows: Array<{ id: string, goal: string, steps: string[] }>
  permissionsPreset: string
  credentials: string[]
  stack: StackPreview
  installPlan: FlowInstallPlanPreview
}
interface FlowCatalogEntry {
  id: string
  name: string
  version: string
  category: string
  goal: string
  targetUsers: string[]
  expectedOutputs: string[]
  validation: Array<{ id: string, kind: string, description: string }>
  variants: FlowVariantPreview[]
  comparisons: Array<{ from: FlowVariantName, to: FlowVariantName, diff: { added: string[], removed: string[], shared: string[] } }>
}
interface RecoveryPoint { backupId: string, profile: string, createdAt: string, createdBy: Action }
interface ProfileRecord {
  id: string
  active: boolean
  managedBy: string
  plugin: { packageName: string, installed: boolean, enabled: boolean, source: string | null, version: string | null }
  recoveryPoints: RecoveryPoint[]
}

const views: Array<{ id: View, label: string, mark: string }> = [
  { id: 'home', label: '总览', mark: '01' },
  { id: 'plugins', label: '插件', mark: '02' },
  { id: 'flows', label: 'Flows', mark: '03' },
  { id: 'profiles', label: 'Profiles', mark: '04' },
  { id: 'tasks', label: '安装任务', mark: '05' },
]

const stateLabel: Record<VerificationState, string> = {
  unknown: '未知', unverified: '未验证', passed: '通过', failed: '失败', stale: '过期',
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`/flow-hub/api/${path}`, { cache: 'no-store' })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `${path} HTTP ${response.status}`)
  return body
}

async function requestPlan(action: PluginAction): Promise<InstallPlan> {
  const response = await fetch('/flow-hub/api/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
  })
  const body = await response.json() as { ok: boolean, plan?: InstallPlan, error?: string }
  if (!response.ok || body.plan === undefined) throw new Error(body.error ?? '无法生成安装计划')
  return body.plan
}

async function requestRollbackPlan(backupId: string): Promise<RollbackPlan> {
  const response = await fetch('/flow-hub/api/rollback-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId }),
  })
  const body = await response.json() as { ok: boolean, plan?: RollbackPlan, error?: string }
  if (!response.ok || body.plan === undefined) throw new Error(body.error ?? '无法生成回滚计划')
  return body.plan
}

async function runAction(plan: OperationPlan): Promise<ActionResponse> {
  const response = await fetch(`/flow-hub/api/${plan.action === 'rollback' ? 'rollback' : 'plugin'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: plan.id }),
  })
  const body = await response.json() as ActionResponse
  return response.ok ? body : { ...body, ok: false }
}

function StatePill({ state }: { state: VerificationState }): ReactNode {
  return <span className={`flowHubPill flowHubPill--${state}`}><i />{stateLabel[state]}</span>
}

function Metric({ value, label, note }: { value: string | number, label: string, note: string }): ReactNode {
  return <article className="flowHubMetric"><strong>{value}</strong><span>{label}</span><small>{note}</small></article>
}

function PlanPreview({ plan, running, execute, cancel }: { plan: OperationPlan, running: Action | null, execute: () => void, cancel: () => void }): ReactNode {
  const rollback = plan.action === 'rollback'
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => { dialogRef.current?.focus() }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && running === null) { event.preventDefault(); event.stopPropagation(); cancel() }
  }
  return <div ref={dialogRef} className="flowHubPlan" role="dialog" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}><b id={titleId}>确认结构化{rollback ? '回滚' : '安装'}计划</b><p className="flowHubPlanHint">按 Esc 可取消；执行前请核对来源、版本、完整性、权限和恢复点。</p><dl><dt>动作</dt><dd>{plan.action}</dd><dt>Profile</dt><dd>{plan.profile}</dd>{rollback ? <><dt>恢复点</dt><dd className="flowHubCode">{plan.backupId}</dd></> : <><dt>来源</dt><dd className="flowHubCode">{plan.source.kind} · {plan.source.spec}</dd><dt>版本</dt><dd className="flowHubCode">{plan.artifact.version}</dd><dt>完整性</dt><dd className="flowHubCode">{shortDigest(plan.artifact.integrity)}</dd><dt>声明脚本</dt><dd>{plan.artifact.lifecycleScripts.length ? plan.artifact.lifecycleScripts.join('、') : '无'}</dd><dt>脚本策略</dt><dd>{plan.risk.lifecycleScriptsDisabled ? '生命周期脚本禁用' : '允许执行'}</dd><dt>网络</dt><dd>{plan.requirements.network.required ? `需要 · ${plan.requirements.network.endpoint ?? '端点未披露'}` : '不需要'}</dd><dt>验证</dt><dd>{plan.risk.verification}</dd><dt>签名</dt><dd>{plan.risk.signature}</dd><dt>权限</dt><dd>{plan.risk.permissions.length ? plan.risk.permissions.join('、') : '无额外声明'}</dd><dt>凭据</dt><dd>{plan.risk.credentials.length ? plan.risk.credentials.join('、') : '无'}</dd></>}<dt>DSH 版本</dt><dd>{plan.requirements.dshVersion}</dd><dt>平台</dt><dd>{plan.requirements.platforms.join('、')}</dd><dt>阶段</dt><dd>{plan.phases.join(' → ')}</dd></dl><div className="flowHubActions"><button className="flowHubButton flowHubButton--primary" disabled={running !== null} onClick={execute}>确认并执行</button><button className="flowHubButton" disabled={running !== null} onClick={cancel}>取消</button></div></div>
}

function shortDigest(value: string): string { return `${value.slice(0, 18)}…${value.slice(-8)}` }

function blockerLabel(value: string): string {
  if (value === 'registry-signature-not-verified') return '当前内置 Registry 尚未绑定已验证签名'
  const [kind, packageName, detail] = value.split(':')
  if (kind === 'plugin-not-verified') return `${packageName} 的验证状态为 ${detail ?? '未知'}`
  if (kind === 'plugin-dsh-compatibility-unknown') return `${packageName} 尚无明确 DSH 兼容范围`
  if (kind === 'plugin-dsh-incompatible') return `${packageName} 声明的 DSH 兼容范围（${detail ?? '未知'}）不包含当前版本`
  if (kind === 'plugin-platform-unverified') return `${packageName} 尚无当前平台运行证据`
  return value
}

function FlowCatalog({ flows }: { flows: FlowCatalogEntry[] }): ReactNode {
  const flow = flows[0]
  const [variantId, setVariantId] = useState<FlowVariantName>('lite')
  useEffect(() => {
    if (flow !== undefined && !flow.variants.some(item => item.id === variantId)) setVariantId(flow.variants[0]?.id ?? 'lite')
  }, [flow, variantId])
  if (flow === undefined) return <div className="flowHubEmpty"><div><b>暂无可预览 Flow</b><p>Registry 发布 Flow 后会在这里显示角色、插件差异与确定性 Stack。</p></div></div>
  const variant = flow.variants.find(item => item.id === variantId) ?? flow.variants[0]
  if (variant === undefined) return null
  const comparison = flow.comparisons.find(item => item.from === variantId || item.to === variantId)
  const peer = comparison === undefined ? null : comparison.from === variantId ? comparison.to : comparison.from
  const diff = comparison === undefined ? null : comparison.from === variantId ? comparison.diff : {
    added: comparison.diff.removed, removed: comparison.diff.added, shared: comparison.diff.shared,
  }
  const onVariantKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: FlowVariantName): void => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      setVariantId(id)
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const current = tabs.indexOf(event.currentTarget)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    const nextId = flow.variants[next]?.id
    if (nextId !== undefined) setVariantId(nextId)
    tabs[next]?.focus()
  }
  return <div className="flowHubFlowLayout">
    <article className="flowHubFlowHero"><div><span className="flowHubEyebrow">{flow.category} · {flow.version}</span><h4>{flow.name}</h4><p>{flow.goal}</p></div><span className="flowHubPreviewBadge">只读预览 · 未验证</span></article>
    <div className="flowHubVariantTabs" role="tablist" aria-label="Flow 变体">{flow.variants.map(item => <button key={item.id} type="button" role="tab" tabIndex={item.id === variantId ? 0 : -1} aria-selected={item.id === variantId} onKeyDown={event => { onVariantKeyDown(event, item.id) }} onClick={() => { setVariantId(item.id) }}><b>{item.id.toUpperCase()}</b><small>{item.plugins.length} 个插件</small></button>)}</div>
    <div className="flowHubFlowColumns">
      <article className="flowHubDetail"><span className="flowHubEyebrow">专家定义</span><h4>{variant.role}</h4><dl><dt>模型</dt><dd>{variant.model.recommended}</dd><dt>权限</dt><dd>{variant.permissionsPreset}</dd><dt>技能</dt><dd>{variant.skills.map(item => item.id).join('、')}</dd><dt>记忆</dt><dd>{variant.memory.map(item => `${item.id} (${item.retention})`).join('、')}</dd><dt>凭据</dt><dd>{variant.credentials.length ? variant.credentials.join('、') : '不需要'}</dd><dt>边界</dt><dd><ul>{variant.boundaries.map(item => <li key={item}>{item}</li>)}</ul></dd><dt>工作流</dt><dd>{variant.workflows.map(item => <div key={item.id}><b>{item.goal}</b><ol>{item.steps.map(step => <li key={step}>{step}</li>)}</ol></div>)}</dd></dl></article>
      <article className="flowHubStack"><div className="flowHubStackHead"><div><span className="flowHubEyebrow">确定性 Stack 预览</span><h4>{variant.stack.profile}</h4></div><span>{variant.stack.platform.os} · DSH {variant.stack.dshVersion}</span></div><p className="flowHubPreviewNotice">候选插件尚未通过兼容性验证，因此不会出现安装按钮，也不会读取或保存你的 API Key。</p><div className="flowHubStackPackages">{variant.stack.packages.map(item => <div key={item.package}><b>{item.package}</b><span>{item.version}</span><small>{shortDigest(item.integrity)}</small></div>)}</div><dl><dt>Flow 摘要</dt><dd className="flowHubCode">{shortDigest(variant.stack.flow.digest)}</dd><dt>配置摘要</dt><dd className="flowHubCode">{shortDigest(variant.stack.configDigest)}</dd><dt>验收</dt><dd>{variant.stack.validations.length} 项 · 安装后执行</dd></dl></article>
    </div>
    <article className="flowHubFlowPlan"><div className="flowHubStackHead"><div><span className="flowHubEyebrow">结构化 Flow 安装计划</span><h4>{variant.installPlan.profile.name}</h4></div><span className={variant.installPlan.executable ? 'flowHubPlanReady' : 'flowHubPlanBlocked'}>{variant.installPlan.executable ? '可执行' : `阻止执行 · ${variant.installPlan.blockers.length}`}</span></div><p>新建隔离的 {variant.installPlan.profile.template} Profile；所有包使用精确来源，生命周期脚本默认禁用。</p><div className="flowHubPlanOps">{variant.installPlan.operations.map(operation => <div key={operation.package}><b>{operation.order}. {operation.package}@{operation.version}</b><StatePill state={operation.verification} /><small>{operation.source.kind} · {operation.source.spec}</small><small>脚本：{operation.lifecycleScripts.length ? operation.lifecycleScripts.join('、') : '无'} · 权限：{operation.permissions.length ? operation.permissions.join('、') : '未声明'} · 凭据：{operation.credentials.length ? operation.credentials.join('、') : '无'}</small></div>)}</div><div className="flowHubPlanSteps" aria-label="Flow 安装阶段">{variant.installPlan.steps.map((step, index) => <span key={step}>{index + 1}. {step}</span>)}</div>{variant.installPlan.blockers.length ? <div className="flowHubBlockers" role="status"><b>执行门尚未满足</b><ul>{variant.installPlan.blockers.map(blocker => <li key={blocker}>{blockerLabel(blocker)}</li>)}</ul></div> : null}<dl><dt>计划 ID</dt><dd className="flowHubCode">{variant.installPlan.id}</dd><dt>权限预设</dt><dd>{variant.installPlan.risk.permissionsPreset}</dd><dt>Registry</dt><dd>{variant.installPlan.risk.registrySignature === 'verified' ? '签名已验证' : '签名未绑定'}</dd></dl></article>
    {diff && peer ? <article className="flowHubCompare"><div><span className="flowHubEyebrow">插件差异</span><h4>{variantId.toUpperCase()} → {peer.toUpperCase()}</h4></div><div><small>增加</small><b>{diff.added.join('、') || '无'}</b></div><div><small>移除</small><b>{diff.removed.join('、') || '无'}</b></div><div><small>共用</small><b>{diff.shared.join('、') || '无'}</b></div></article> : null}
  </div>
}

export function FlowHubFullUI({ bootstrap }: { bootstrap: BootstrapResponse }): ReactNode {
  const [view, setView] = useState<View>('home')
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [registryAvailability, setRegistryAvailability] = useState<RegistryAvailability | null>(null)
  const [profiles, setProfiles] = useState<ProfileRecord[]>([])
  const [tasks, setTasks] = useState<ActionResponse[]>([])
  const [flows, setFlows] = useState<FlowCatalogEntry[]>([])
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [running, setRunning] = useState<Action | null>(null)
  const [result, setResult] = useState<ActionResponse | null>(null)
  const [plan, setPlan] = useState<OperationPlan | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const planTriggerRef = useRef<HTMLElement | null>(null)
  const planWasOpenRef = useRef(false)
  const mainRef = useRef<HTMLElement>(null)

  const refresh = useCallback(() => {
    setRegistryError(null)
    setLocalError(null)
    void Promise.allSettled([
      api<{ ok: true, registry: Registry, availability: RegistryAvailability }>('registry'),
      api<{ ok: true, profiles: ProfileRecord[] }>('profiles'), api<{ ok: true, tasks: ActionResponse[] }>('tasks'),
      api<{ ok: true, flows: FlowCatalogEntry[] }>('flows'),
    ]).then(([nextRegistry, nextProfiles, nextTasks, nextFlows]) => {
      if (nextRegistry.status === 'fulfilled') {
        setRegistry(nextRegistry.value.registry)
        setRegistryAvailability(nextRegistry.value.availability)
      } else {
        setRegistry(null)
        setRegistryAvailability({ catalog: 'unavailable', upstream: 'unreachable', offlineReady: false })
        setRegistryError(nextRegistry.reason instanceof Error ? nextRegistry.reason.message : String(nextRegistry.reason))
      }
      if (nextProfiles.status === 'fulfilled') setProfiles(nextProfiles.value.profiles)
      if (nextTasks.status === 'fulfilled') setTasks(nextTasks.value.tasks)
      if (nextFlows.status === 'fulfilled') setFlows(nextFlows.value.flows)
      const failures = [
        nextProfiles.status === 'rejected' ? `Profiles: ${nextProfiles.reason instanceof Error ? nextProfiles.reason.message : String(nextProfiles.reason)}` : null,
        nextTasks.status === 'rejected' ? `Tasks: ${nextTasks.reason instanceof Error ? nextTasks.reason.message : String(nextTasks.reason)}` : null,
        nextFlows.status === 'rejected' ? `Flows: ${nextFlows.reason instanceof Error ? nextFlows.reason.message : String(nextFlows.reason)}` : null,
      ].filter((value): value is string => value !== null)
      setLocalError(failures.length ? failures.join(' · ') : null)
    })
  }, [])

  useEffect(refresh, [refresh])
  useEffect(() => {
    if (selected === null && registry?.plugins[0] !== undefined) setSelected(registry.plugins[0].id)
  }, [registry, selected])
  useEffect(() => {
    if (plan !== null) { planWasOpenRef.current = true; return }
    if (!planWasOpenRef.current) return
    planWasOpenRef.current = false
    const target = planTriggerRef.current?.isConnected ? planTriggerRef.current : mainRef.current
    window.setTimeout(() => { target?.focus() }, 50)
  }, [plan])

  const prepare = (action: PluginAction, trigger?: HTMLElement): void => {
    planTriggerRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setRunning(action)
    setResult(null)
    setPlan(null)
    void requestPlan(action).then(setPlan, reason => {
      setResult({ ok: false, error: reason instanceof Error ? reason.message : String(reason) })
    }).finally(() => { setRunning(null) })
  }

  const prepareRollback = (backupId: string, trigger?: HTMLElement): void => {
    planTriggerRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setView('home')
    setRunning('rollback')
    setResult(null)
    setPlan(null)
    void requestRollbackPlan(backupId).then(setPlan, reason => {
      setResult({ ok: false, error: reason instanceof Error ? reason.message : String(reason) })
    }).finally(() => { setRunning(null) })
  }

  const execute = (): void => {
    if (plan === null) return
    setRunning(plan.action)
    setResult(null)
    void runAction(plan).then(response => { setResult(response); setPlan(null); refresh() }, reason => {
      setResult({ ok: false, error: reason instanceof Error ? reason.message : String(reason) })
    }).finally(() => { setRunning(null) })
  }

  const cancelPlan = (): void => { setPlan(null) }

  const plugins = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return registry?.plugins ?? []
    return (registry?.plugins ?? []).filter(plugin => `${plugin.package} ${plugin.id} ${plugin.license ?? ''}`.toLowerCase().includes(needle))
  }, [query, registry])
  useEffect(() => {
    if (!plugins.some(plugin => plugin.id === selected)) setSelected(plugins[0]?.id ?? null)
  }, [plugins, selected])
  const selectedPlugin = plugins.find(plugin => plugin.id === selected) ?? null
  const compatible = bootstrap.state === 'compatible'
  const blocked = !compatible || !bootstrap.fixtureReady || running !== null
  const failedCount = registry?.plugins.filter(plugin => plugin.verification.state === 'failed').length ?? 0
  const verifiedCount = registry?.plugins.filter(plugin => plugin.verification.state === 'passed').length ?? 0

  return (
    <section className="flowHubShell">
      <style>{`
        .flowHubShell{--fh-accent:#e08a32;--fh-green:#3b9a82;--fh-red:#c95c58;--fh-line:color-mix(in srgb,currentColor 14%,transparent);container-type:inline-size;font-family:"Aptos","Noto Sans SC",sans-serif;color:inherit;min-height:620px;border:1px solid var(--fh-line);border-radius:18px;overflow:hidden;background:linear-gradient(145deg,color-mix(in srgb,currentColor 4%,transparent),transparent 42%),radial-gradient(circle at 85% -10%,color-mix(in srgb,var(--fh-accent) 14%,transparent),transparent 34%);box-shadow:0 22px 70px color-mix(in srgb,#000 13%,transparent)}
        .flowHubTop{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;padding:28px 30px 22px;border-bottom:1px solid var(--fh-line)}.flowHubKicker{margin:0 0 7px;font:700 11px/1.2 ui-monospace,monospace;letter-spacing:.18em;color:var(--fh-accent)}.flowHubTitle{margin:0;font:600 clamp(25px,4vw,42px)/1.05 "Iowan Old Style","Noto Serif SC",serif;letter-spacing:-.025em}.flowHubSub{margin:10px 0 0;max-width:700px;opacity:.66;font-size:13px;line-height:1.6}
        .flowHubStatus{align-self:start;display:grid;justify-items:end;gap:8px;font-size:12px}.flowHubStatus b{display:flex;align-items:center;gap:8px}.flowHubStatus b:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--fh-red);box-shadow:0 0 0 5px color-mix(in srgb,var(--fh-red) 15%,transparent)}.flowHubStatus--compatible b:before{background:var(--fh-green);box-shadow:0 0 0 5px color-mix(in srgb,var(--fh-green) 15%,transparent)}.flowHubStatus--unknown b:before{background:var(--fh-accent);box-shadow:0 0 0 5px color-mix(in srgb,var(--fh-accent) 15%,transparent)}
        .flowHubBody{display:grid;grid-template-columns:172px minmax(0,1fr);min-height:520px}.flowHubNav{padding:18px 12px;border-right:1px solid var(--fh-line);display:flex;flex-direction:column;gap:4px}.flowHubNav button{display:grid;grid-template-columns:28px 1fr;gap:8px;align-items:center;min-height:44px;border:0;border-radius:9px;padding:11px 10px;background:transparent;color:inherit;text-align:left;cursor:pointer}.flowHubNav button:hover{background:color-mix(in srgb,currentColor 6%,transparent)}.flowHubNav button[aria-current=page]{background:color-mix(in srgb,var(--fh-accent) 13%,transparent);color:color-mix(in srgb,var(--fh-accent) 80%,currentColor)}.flowHubNav small{font:600 9px/1 ui-monospace,monospace;opacity:.48}.flowHubNav span{font-size:13px;font-weight:650}
        .flowHubMain{padding:24px 26px 34px;min-width:0}.flowHubSectionHead{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:18px}.flowHubSectionHead h3{margin:0;font:600 23px/1.2 "Iowan Old Style","Noto Serif SC",serif}.flowHubSectionHead p{margin:5px 0 0;font-size:12px;opacity:.58}.flowHubGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.flowHubMetric{min-height:118px;border:1px solid var(--fh-line);border-radius:12px;padding:16px;background:color-mix(in srgb,currentColor 2%,transparent);display:flex;flex-direction:column}.flowHubMetric strong{font:600 31px/1 ui-monospace,monospace}.flowHubMetric span{margin-top:13px;font-size:12px;font-weight:700}.flowHubMetric small{margin-top:4px;opacity:.5;font-size:10px}
        .flowHubPanel{border:1px solid var(--fh-line);border-radius:13px;padding:18px;margin-top:12px;background:color-mix(in srgb,currentColor 2%,transparent)}.flowHubPanel h4{margin:0 0 8px;font-size:14px}.flowHubPanel p{margin:0;opacity:.64;font-size:12px;line-height:1.65}.flowHubActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.flowHubButton{min-height:44px;border:1px solid var(--fh-line);border-radius:8px;padding:8px 13px;background:transparent;color:inherit;cursor:pointer;font-weight:650}.flowHubButton:hover:not(:disabled){border-color:var(--fh-accent);transform:translateY(-1px)}.flowHubButton--primary{background:var(--fh-accent);border-color:var(--fh-accent);color:#21170e}.flowHubButton:disabled{opacity:.38;cursor:not-allowed}.flowHubButton:focus-visible,.flowHubNav button:focus-visible,.flowHubPlugin:focus-visible,.flowHubSearch:focus-visible,.flowHubPlan:focus-visible,.flowHubVariantTabs button:focus-visible{outline:3px solid color-mix(in srgb,var(--fh-accent) 78%,white);outline-offset:2px}.flowHubPlan{margin-top:14px;border:1px solid color-mix(in srgb,var(--fh-accent) 45%,var(--fh-line));border-radius:11px;padding:14px}.flowHubPlanHint{margin:6px 0 0;font-size:11px;opacity:.66}.flowHubPlan dl{display:grid;grid-template-columns:78px 1fr;gap:7px;margin:10px 0;font-size:11px}.flowHubPlan dt{opacity:.5}.flowHubPlan dd{margin:0;overflow-wrap:anywhere}
        .flowHubSearch{width:min(310px,100%);min-height:44px;border:1px solid var(--fh-line);border-radius:9px;padding:9px 12px;background:transparent;color:inherit;outline:none}.flowHubSearch:focus{border-color:var(--fh-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--fh-accent) 13%,transparent)}.flowHubPluginLayout{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,.72fr);gap:12px}.flowHubList{display:grid;gap:7px;max-height:420px;overflow:auto;padding-right:3px}.flowHubPlugin{min-height:54px;border:1px solid var(--fh-line);border-radius:10px;padding:13px 14px;background:transparent;color:inherit;text-align:left;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:8px}.flowHubPlugin:hover,.flowHubPlugin[aria-current=true]{border-color:color-mix(in srgb,var(--fh-accent) 55%,var(--fh-line));background:color-mix(in srgb,var(--fh-accent) 6%,transparent)}.flowHubPlugin strong{font-size:13px;overflow-wrap:anywhere}.flowHubPlugin small{display:block;margin-top:4px;opacity:.5}
        .flowHubPill{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:10px;font-weight:750}.flowHubPill i{width:6px;height:6px;border-radius:50%;background:#8b8b8b}.flowHubPill--passed i{background:var(--fh-green)}.flowHubPill--failed i{background:var(--fh-red)}.flowHubPill--stale i{background:var(--fh-accent)}.flowHubDetail{border:1px solid var(--fh-line);border-radius:12px;padding:17px;min-height:220px}.flowHubDetail h4{margin:0 0 5px;font-size:15px;overflow-wrap:anywhere}.flowHubDetail dl{display:grid;grid-template-columns:78px 1fr;gap:9px;margin:18px 0 0;font-size:11px}.flowHubDetail dt{opacity:.48}.flowHubDetail dd{margin:0;overflow-wrap:anywhere}.flowHubCode{font-family:ui-monospace,monospace;font-size:10px}
        .flowHubFlowLayout{display:grid;gap:12px}.flowHubFlowHero{display:flex;align-items:start;justify-content:space-between;gap:18px;border:1px solid var(--fh-line);border-radius:14px;padding:18px;background:linear-gradient(125deg,color-mix(in srgb,var(--fh-accent) 10%,transparent),transparent 58%)}.flowHubFlowHero h4,.flowHubStack h4,.flowHubCompare h4{margin:4px 0 6px;font:600 19px/1.2 "Iowan Old Style","Noto Serif SC",serif}.flowHubFlowHero p{margin:0;font-size:12px;line-height:1.65;opacity:.68}.flowHubEyebrow{font:700 9px/1.2 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase;opacity:.55}.flowHubPreviewBadge{white-space:nowrap;border:1px solid color-mix(in srgb,var(--fh-accent) 45%,var(--fh-line));border-radius:999px;padding:7px 10px;font-size:10px;color:var(--fh-accent)}.flowHubVariantTabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.flowHubVariantTabs button{min-height:54px;border:1px solid var(--fh-line);border-radius:10px;padding:10px 13px;background:transparent;color:inherit;text-align:left;cursor:pointer}.flowHubVariantTabs button[aria-selected=true]{border-color:var(--fh-accent);background:color-mix(in srgb,var(--fh-accent) 10%,transparent)}.flowHubVariantTabs b,.flowHubVariantTabs small{display:block}.flowHubVariantTabs small{margin-top:4px;opacity:.5}.flowHubFlowColumns{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.86fr);gap:12px}.flowHubDetail ul,.flowHubDetail ol{margin:4px 0 0;padding-left:18px}.flowHubDetail li{margin:4px 0;line-height:1.45}.flowHubStack{border:1px solid var(--fh-line);border-radius:12px;padding:17px;background:color-mix(in srgb,currentColor 2%,transparent)}.flowHubStackHead{display:flex;justify-content:space-between;gap:12px}.flowHubStackHead>span{font-size:10px;opacity:.5}.flowHubPreviewNotice{border-left:3px solid var(--fh-accent);padding:9px 11px;background:color-mix(in srgb,var(--fh-accent) 8%,transparent);font-size:11px;line-height:1.55}.flowHubStackPackages{display:grid;gap:7px;margin:14px 0}.flowHubStackPackages>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;border-bottom:1px solid var(--fh-line);padding:8px 0}.flowHubStackPackages b{font-size:11px;overflow-wrap:anywhere}.flowHubStackPackages span{font:600 10px ui-monospace,monospace}.flowHubStackPackages small{grid-column:1/-1;font:9px ui-monospace,monospace;opacity:.48;overflow-wrap:anywhere}.flowHubStack dl{display:grid;grid-template-columns:82px 1fr;gap:8px;margin:14px 0 0;font-size:10px}.flowHubStack dt{opacity:.5}.flowHubStack dd{margin:0;overflow-wrap:anywhere}.flowHubCompare{display:grid;grid-template-columns:minmax(150px,.8fr) repeat(3,minmax(0,1fr));gap:12px;align-items:center;border:1px solid var(--fh-line);border-radius:12px;padding:15px}.flowHubCompare>div:not(:first-child){border-left:1px solid var(--fh-line);padding-left:12px;min-width:0}.flowHubCompare small,.flowHubCompare b{display:block}.flowHubCompare small{font-size:9px;opacity:.5}.flowHubCompare b{margin-top:5px;font-size:10px;overflow-wrap:anywhere}
        .flowHubFlowPlan{border:1px solid var(--fh-line);border-radius:12px;padding:17px}.flowHubFlowPlan h4{margin:4px 0 6px;font:600 17px/1.2 "Iowan Old Style","Noto Serif SC",serif}.flowHubFlowPlan>p{margin:8px 0;font-size:11px;opacity:.66}.flowHubPlanBlocked,.flowHubPlanReady{align-self:start;border-radius:999px;padding:6px 9px;font-weight:700}.flowHubPlanBlocked{color:var(--fh-red);background:color-mix(in srgb,var(--fh-red) 10%,transparent)}.flowHubPlanReady{color:var(--fh-green);background:color-mix(in srgb,var(--fh-green) 10%,transparent)}.flowHubPlanOps{display:grid;gap:7px;margin:12px 0}.flowHubPlanOps>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;border:1px solid var(--fh-line);border-radius:9px;padding:10px}.flowHubPlanOps small{grid-column:1/-1;font-size:9px;opacity:.55;overflow-wrap:anywhere}.flowHubPlanSteps{display:flex;flex-wrap:wrap;gap:5px;margin:12px 0}.flowHubPlanSteps span{border:1px solid var(--fh-line);border-radius:999px;padding:5px 8px;font:9px ui-monospace,monospace}.flowHubBlockers{border-left:3px solid var(--fh-red);padding:9px 11px;background:color-mix(in srgb,var(--fh-red) 8%,transparent);font-size:10px}.flowHubBlockers ul{margin:6px 0 0;padding-left:18px}.flowHubFlowPlan dl{display:grid;grid-template-columns:82px 1fr;gap:7px;margin:12px 0 0;font-size:10px}.flowHubFlowPlan dt{opacity:.5}.flowHubFlowPlan dd{margin:0}
        .flowHubEmpty{display:grid;place-items:center;text-align:center;min-height:270px;border:1px dashed var(--fh-line);border-radius:13px;padding:28px}.flowHubEmpty b{font:600 22px/1.2 "Iowan Old Style","Noto Serif SC",serif}.flowHubEmpty p{max-width:440px;opacity:.58;font-size:12px;line-height:1.7}.flowHubTask{display:grid;grid-template-columns:90px 1fr auto;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--fh-line);font-size:11px}.flowHubTask:last-child{border-bottom:0}.flowHubAlert{margin-bottom:14px;border-left:3px solid var(--fh-red);padding:10px 12px;background:color-mix(in srgb,var(--fh-red) 8%,transparent);font-size:12px}.flowHubAlert--offline{border-color:var(--fh-accent);background:color-mix(in srgb,var(--fh-accent) 8%,transparent)}.flowHubResult{margin-top:12px;border-left:3px solid var(--fh-green);padding:10px 12px;background:color-mix(in srgb,var(--fh-green) 8%,transparent);font-size:11px}.flowHubResult--bad{border-color:var(--fh-red)}.flowHubResult pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
        @container(max-width:760px){.flowHubTop{grid-template-columns:1fr;padding:22px}.flowHubStatus{justify-items:start}.flowHubBody{grid-template-columns:1fr}.flowHubNav{border-right:0;border-bottom:1px solid var(--fh-line);display:grid;grid-template-columns:repeat(5,minmax(86px,1fr));overflow:auto}.flowHubNav button{grid-template-columns:1fr;gap:3px;text-align:center;padding:9px 5px}.flowHubMain{padding:20px 16px}.flowHubGrid{grid-template-columns:1fr 1fr}.flowHubPluginLayout,.flowHubFlowColumns{grid-template-columns:1fr}.flowHubList{max-height:270px}.flowHubDetail{min-height:0}.flowHubSectionHead{align-items:start;flex-direction:column}.flowHubTask{grid-template-columns:72px 1fr}.flowHubCompare{grid-template-columns:1fr 1fr}.flowHubCompare>div:not(:first-child){border-left:0;border-top:1px solid var(--fh-line);padding:10px 0 0}.flowHubFlowHero{flex-direction:column}.flowHubPreviewBadge{white-space:normal}}
        @media(max-width:900px){.flowHubGrid{grid-template-columns:repeat(2,1fr)}.flowHubPluginLayout{grid-template-columns:1fr}.flowHubDetail{min-height:0}}@media(max-width:650px){.flowHubGrid{grid-template-columns:1fr}}@media(prefers-reduced-motion:no-preference){.flowHubMain>*{animation:fh-rise .28s ease both}@keyframes fh-rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}}
      `}</style>
      <header className="flowHubTop"><div><p className="flowHubKicker">DEEPSEEK HARNESS / FLOW HUB</p><h2 className="flowHubTitle">组装你的 Agent 工作台</h2><p className="flowHubSub">插件是能力，Flow 是经过验证的专家方案。所有发现、检查、安装与恢复都留在当前 DSH 界面。</p></div><div className={`flowHubStatus flowHubStatus--${bootstrap.state}`} role="status" aria-live="polite"><b>{compatible ? '四维兼容，可执行' : bootstrap.state === 'unknown' ? '版本未知，只读' : '不兼容，只读'}</b><span>DSH {bootstrap.dshVersion ?? '—'} · Hub {bootstrap.hubVersion ?? '—'}</span><span>Registry Schema {bootstrap.compatibility.dimensions.registrySchema.actual ?? '—'} · Flow Schema {bootstrap.compatibility.dimensions.flowSchema.actual ?? '—'}</span></div></header>
      <div className="flowHubBody">
        <nav className="flowHubNav" aria-label="Flow Hub 区域">{views.map(item => <button key={item.id} type="button" aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id) }}><small>{item.mark}</small><span>{item.label}</span></button>)}</nav>
        <main ref={mainRef} className="flowHubMain" tabIndex={-1} aria-busy={running !== null}>
          {registryAvailability?.upstream === 'unreachable' && registryAvailability.offlineReady ? <div className="flowHubAlert flowHubAlert--offline" role="status" aria-live="polite"><b>上游 Registry 不可达，已切换固定本地快照。</b><br />已安装 Profile、恢复点和本地任务继续从当前 DSH Host 读取；离线不会被误报为空结果。</div> : null}
          {registryError ? <div className="flowHubAlert flowHubAlert--offline" role="alert"><b>Registry 当前不可用。</b><br />插件发现与 Flow 目录暂不可用；已安装 Profiles、恢复点和本地任务仍可管理。错误：{registryError}</div> : null}
          {localError ? <div className="flowHubAlert" role="alert">部分本地数据不可用：{localError}</div> : null}
          {bootstrap.testFailurePhase ? <div className="flowHubAlert" role="alert">隔离测试模式：事务将在 {bootstrap.testFailurePhase} 阶段注入故障；失败后必须显示已回滚。</div> : null}
          {view === 'home' ? <><div className="flowHubSectionHead"><div><h3>可信能力地图</h3><p>Registry 只陈述证据，不把“被发现”包装成“已可信”。</p></div><button className="flowHubButton" type="button" onClick={refresh}>刷新状态</button></div><div className="flowHubGrid"><Metric value={registry?.plugins.length ?? '—'} label="候选插件" note={`Registry ${registry?.registryVersion ?? '载入中'}`} /><Metric value={verifiedCount} label="验证通过" note="完整运行证据" /><Metric value={failedCount} label="验证失败" note="失败同样公开" /><Metric value={registry?.flows.length ?? 0} label="专家 Flow" note="即将进入首发批次" /></div><div className="flowHubPanel"><h4>测试安装通道</h4><p>当前 Alpha 只允许固定的 hello bundle 进入写操作。兼容性不确定时，Bootstrap 会自动保持只读。</p><div className="flowHubActions"><button className="flowHubButton flowHubButton--primary" disabled={blocked || profiles[0]?.plugin.installed === true} onClick={event => { prepare('add', event.currentTarget) }}>{running === 'add' ? '生成计划中…' : profiles[0]?.plugin.installed ? '已安装' : '安装测试 Bundle'}</button><button className="flowHubButton" disabled={blocked || profiles[0]?.plugin.installed !== true} onClick={event => { prepare('update', event.currentTarget) }}>{running === 'update' ? '生成计划中…' : '更新'}</button><button className="flowHubButton" disabled={blocked || profiles[0]?.plugin.installed !== true} onClick={event => { prepare('remove', event.currentTarget) }}>{running === 'remove' ? '生成计划中…' : '卸载'}</button></div>{plan ? <PlanPreview plan={plan} running={running} execute={execute} cancel={cancelPlan} /> : null}{result ? <div className={`flowHubResult${result.ok ? '' : ' flowHubResult--bad'}`} role={result.ok ? 'status' : 'alert'}><b>{result.ok ? '事务成功' : '事务未完成'}</b><pre>{result.error ?? result.phases?.map(item => `${item.phase}: ${item.status}${item.detail ? ` (${item.detail})` : ''}`).join('\n') ?? '无阶段结果'}</pre>{result.ok ? null : <p>请刷新状态确认 Profile；若仍异常，使用 Profiles 恢复点或 CLI 救援命令。</p>}</div> : null}</div></> : null}
          {view === 'plugins' ? <>
            <div className="flowHubSectionHead"><div><h3>插件 Registry</h3><p aria-live="polite">{plugins.length} 个结果 · 来源与验证状态始终可见</p></div><input className="flowHubSearch" type="search" aria-label="搜索插件" value={query} placeholder="搜索名称或许可证…" onChange={event => { setQuery(event.target.value) }} /></div>
            <div className="flowHubPluginLayout">
              <div className="flowHubList" aria-label="插件搜索结果">{plugins.map(plugin => <button className="flowHubPlugin" type="button" key={plugin.id} aria-current={selected === plugin.id} onClick={() => { setSelected(plugin.id) }}><span><strong>{plugin.package}</strong><small>{plugin.version} · {plugin.license ?? '许可证未知'}</small></span><StatePill state={plugin.verification.state} /></button>)}</div>
              <aside className="flowHubDetail" aria-live="polite">{selectedPlugin ? <>
                <StatePill state={selectedPlugin.verification.state} /><h4>{selectedPlugin.package}</h4><small>{selectedPlugin.id}</small>
                <dl><dt>版本</dt><dd>{selectedPlugin.version}</dd><dt>来源</dt><dd className="flowHubCode">{selectedPlugin.source.spec}</dd><dt>来源固定</dt><dd>{sourcePinning(selectedPlugin)}</dd><dt>完整性</dt><dd className="flowHubCode">{selectedPlugin.source.integrity ?? selectedPlugin.source.commit ?? '未披露'}</dd><dt>许可证</dt><dd>{selectedPlugin.license ?? '未披露'}</dd><dt>安装脚本</dt><dd>{Object.keys(selectedPlugin.lifecycleScripts).length ? Object.keys(selectedPlugin.lifecycleScripts).join('、') : '无披露脚本'}</dd><dt>权限</dt><dd>{selectedPlugin.permissions.length ? selectedPlugin.permissions.join('、') : '未声明额外权限'}</dd><dt>凭据</dt><dd>{selectedPlugin.credentials.length ? selectedPlugin.credentials.join('、') : '未声明凭据需求'}</dd><dt>验证时间</dt><dd>{selectedPlugin.verification.verifiedAt ?? '尚无运行证据'}</dd><dt>环境</dt><dd>{selectedPlugin.verification.environment ? `${selectedPlugin.verification.environment.os} · ${selectedPlugin.verification.environment.arch} · ${selectedPlugin.verification.environment.node}` : '尚无运行证据'}</dd><dt>DSH 版本</dt><dd>{selectedPlugin.verification.dshVersion ?? '尚无运行证据'}</dd><dt>证据链接</dt><dd className="flowHubCode">{selectedPlugin.verification.evidence?.find(item => item.startsWith('https://github.com/Harzva/harness-flow-hub/blob/registry-v')) ?? '尚无公开验证证据'}</dd></dl>
              </> : <div className="flowHubEmpty"><div><b>没有匹配插件</b><p>尝试缩短搜索词，或搜索插件名称和许可证。</p></div></div>}</aside>
            </div>
          </> : null}
          {view === 'flows' ? <><div className="flowHubSectionHead"><div><h3>Harness Flows</h3><p>完整的领域专家方案；先比较变体和 Stack，再决定是否安装。</p></div></div><FlowCatalog flows={flows} /></> : null}
          {view === 'profiles' ? <><div className="flowHubSectionHead"><div><h3>Profiles</h3><p>安装状态、来源和恢复点来自 Host，不依赖浏览器猜测。</p></div></div>{profiles.map(profile => <article className="flowHubPanel" key={profile.id}><h4>{profile.id} {profile.active ? '· 当前' : ''}</h4><p>{profile.plugin.installed ? `${profile.plugin.packageName} ${profile.plugin.version ?? '版本未知'} · ${profile.plugin.enabled ? '已启用' : '未启用'} · ${profile.plugin.source ?? '来源未知'}` : '测试 Bundle 未安装'}。由 {profile.managedBy} 管理。</p><div className="flowHubActions"><button className="flowHubButton" disabled={blocked || !profile.plugin.installed} onClick={event => { prepare('update', event.currentTarget); setView('home') }}>更新预览</button><button className="flowHubButton" disabled={blocked || !profile.plugin.installed} onClick={event => { prepare('remove', event.currentTarget); setView('home') }}>卸载预览</button><button className="flowHubButton" disabled title="等待 DSH 提供外部插件设置契约">设置</button><button className="flowHubButton" disabled title="等待 DSH 提供稳定启停契约">{profile.plugin.enabled ? '停用' : '启用'}</button></div><h4>恢复点</h4>{profile.recoveryPoints.length ? profile.recoveryPoints.map(point => <div className="flowHubTask" key={point.backupId}><b>{point.createdBy}</b><span>{new Date(point.createdAt).toLocaleString()} · <span className="flowHubCode">{point.backupId}</span></span><button className="flowHubButton" disabled={blocked} onClick={event => { prepareRollback(point.backupId, event.currentTarget) }}>回滚预览</button></div>) : <p>尚无可用恢复点。成功安装、更新、卸载或回滚后会保留恢复点。</p>}</article>)}</> : null}
          {view === 'tasks' ? <><div className="flowHubSectionHead"><div><h3>安装任务</h3><p>每一步都留下结果，失败不会被成功提示覆盖。</p></div></div><div className="flowHubPanel">{tasks.length ? tasks.map((task, index) => <div className="flowHubTask" key={`${task.startedAt ?? index}`}><b>{task.action ?? '任务'}</b><span>{task.startedAt ? new Date(task.startedAt).toLocaleString() : '时间未知'} · {task.phases?.map(item => item.phase).join(' → ')}</span><span>{task.ok ? '成功' : '已回滚'}</span></div>) : <div className="flowHubEmpty"><div><b>还没有安装任务</b><p>从总览发起测试安装后，结果会出现在这里。</p></div></div>}</div></> : null}
        </main>
      </div>
    </section>
  )
}
