import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

export const inject = ['slots']

type BootstrapState = 'compatible' | 'unknown' | 'incompatible'
type PluginAction = 'add' | 'update' | 'remove'
type Action = PluginAction | 'rollback'
type View = 'home' | 'plugins' | 'flows' | 'profiles' | 'tasks'
type VerificationState = 'unknown' | 'unverified' | 'passed' | 'failed' | 'stale'

interface BootstrapResponse {
  ok: boolean
  state: BootstrapState
  dshVersion: string | null
  hubVersion: string | null
  supported: string
  profile: string
  fixtureReady: boolean
  packageName: string
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
  verification: { state: VerificationState, platform?: string, dshVersion?: string, evidence?: string[] }
}

interface Registry { registryVersion: string, plugins: PluginRecord[], flows: unknown[] }
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
  return <div className="flowHubPlan" role="dialog" aria-label={rollback ? '回滚计划预览' : '安装计划预览'}><b>确认结构化{rollback ? '回滚' : '安装'}计划</b><dl><dt>动作</dt><dd>{plan.action}</dd><dt>Profile</dt><dd>{plan.profile}</dd>{rollback ? <><dt>恢复点</dt><dd className="flowHubCode">{plan.backupId}</dd></> : <><dt>来源</dt><dd className="flowHubCode">{plan.source.kind} · {plan.source.spec}</dd><dt>网络</dt><dd>{plan.requirements.network.required ? `需要 · ${plan.requirements.network.endpoint ?? '端点未披露'}` : '不需要'}</dd><dt>验证</dt><dd>{plan.risk.verification}</dd><dt>签名</dt><dd>{plan.risk.signature}</dd><dt>脚本</dt><dd>{plan.risk.lifecycleScriptsDisabled ? '生命周期脚本禁用' : '允许执行'}</dd><dt>权限</dt><dd>{plan.risk.permissions.length ? plan.risk.permissions.join('、') : '无额外声明'}</dd><dt>凭据</dt><dd>{plan.risk.credentials.length ? plan.risk.credentials.join('、') : '无'}</dd></>}<dt>DSH 版本</dt><dd>{plan.requirements.dshVersion}</dd><dt>平台</dt><dd>{plan.requirements.platforms.join('、')}</dd><dt>阶段</dt><dd>{plan.phases.join(' → ')}</dd></dl><div className="flowHubActions"><button className="flowHubButton flowHubButton--primary" disabled={running !== null} onClick={execute}>确认并执行</button><button className="flowHubButton" disabled={running !== null} onClick={cancel}>取消</button></div></div>
}

export function FlowHubTab(): ReactNode {
  const [view, setView] = useState<View>('home')
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [profiles, setProfiles] = useState<ProfileRecord[]>([])
  const [tasks, setTasks] = useState<ActionResponse[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<Action | null>(null)
  const [result, setResult] = useState<ActionResponse | null>(null)
  const [plan, setPlan] = useState<OperationPlan | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setError(null)
    void Promise.all([
      api<BootstrapResponse>('bootstrap'), api<{ ok: true, registry: Registry }>('registry'),
      api<{ ok: true, profiles: ProfileRecord[] }>('profiles'), api<{ ok: true, tasks: ActionResponse[] }>('tasks'),
    ]).then(([nextBootstrap, nextRegistry, nextProfiles, nextTasks]) => {
      setBootstrap(nextBootstrap)
      setRegistry(nextRegistry.registry)
      setProfiles(nextProfiles.profiles)
      setTasks(nextTasks.tasks)
    }, reason => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [])

  useEffect(refresh, [refresh])
  useEffect(() => {
    if (selected === null && registry?.plugins[0] !== undefined) setSelected(registry.plugins[0].id)
  }, [registry, selected])

  const prepare = (action: PluginAction): void => {
    setRunning(action)
    setResult(null)
    setPlan(null)
    void requestPlan(action).then(setPlan, reason => {
      setResult({ ok: false, error: reason instanceof Error ? reason.message : String(reason) })
    }).finally(() => { setRunning(null) })
  }

  const prepareRollback = (backupId: string): void => {
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

  const plugins = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return registry?.plugins ?? []
    return (registry?.plugins ?? []).filter(plugin => `${plugin.package} ${plugin.id} ${plugin.license ?? ''}`.toLowerCase().includes(needle))
  }, [query, registry])
  const selectedPlugin = registry?.plugins.find(plugin => plugin.id === selected) ?? null
  const compatible = bootstrap?.state === 'compatible'
  const blocked = !compatible || !bootstrap?.fixtureReady || running !== null
  const failedCount = registry?.plugins.filter(plugin => plugin.verification.state === 'failed').length ?? 0
  const verifiedCount = registry?.plugins.filter(plugin => plugin.verification.state === 'passed').length ?? 0

  return (
    <section className="flowHubShell">
      <style>{`
        .flowHubShell{--fh-accent:#e08a32;--fh-green:#3b9a82;--fh-red:#c95c58;--fh-line:color-mix(in srgb,currentColor 14%,transparent);container-type:inline-size;font-family:"Aptos","Noto Sans SC",sans-serif;color:inherit;min-height:620px;border:1px solid var(--fh-line);border-radius:18px;overflow:hidden;background:linear-gradient(145deg,color-mix(in srgb,currentColor 4%,transparent),transparent 42%),radial-gradient(circle at 85% -10%,color-mix(in srgb,var(--fh-accent) 14%,transparent),transparent 34%);box-shadow:0 22px 70px color-mix(in srgb,#000 13%,transparent)}
        .flowHubTop{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;padding:28px 30px 22px;border-bottom:1px solid var(--fh-line)}.flowHubKicker{margin:0 0 7px;font:700 11px/1.2 ui-monospace,monospace;letter-spacing:.18em;color:var(--fh-accent)}.flowHubTitle{margin:0;font:600 clamp(25px,4vw,42px)/1.05 "Iowan Old Style","Noto Serif SC",serif;letter-spacing:-.025em}.flowHubSub{margin:10px 0 0;max-width:700px;opacity:.66;font-size:13px;line-height:1.6}
        .flowHubStatus{align-self:start;display:grid;justify-items:end;gap:8px;font-size:12px}.flowHubStatus b{display:flex;align-items:center;gap:8px}.flowHubStatus b:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--fh-green);box-shadow:0 0 0 5px color-mix(in srgb,var(--fh-green) 15%,transparent)}
        .flowHubBody{display:grid;grid-template-columns:172px minmax(0,1fr);min-height:520px}.flowHubNav{padding:18px 12px;border-right:1px solid var(--fh-line);display:flex;flex-direction:column;gap:4px}.flowHubNav button{display:grid;grid-template-columns:28px 1fr;gap:8px;align-items:center;border:0;border-radius:9px;padding:11px 10px;background:transparent;color:inherit;text-align:left;cursor:pointer}.flowHubNav button:hover{background:color-mix(in srgb,currentColor 6%,transparent)}.flowHubNav button[aria-selected=true]{background:color-mix(in srgb,var(--fh-accent) 13%,transparent);color:color-mix(in srgb,var(--fh-accent) 80%,currentColor)}.flowHubNav small{font:600 9px/1 ui-monospace,monospace;opacity:.48}.flowHubNav span{font-size:13px;font-weight:650}
        .flowHubMain{padding:24px 26px 34px;min-width:0}.flowHubSectionHead{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:18px}.flowHubSectionHead h3{margin:0;font:600 23px/1.2 "Iowan Old Style","Noto Serif SC",serif}.flowHubSectionHead p{margin:5px 0 0;font-size:12px;opacity:.58}.flowHubGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.flowHubMetric{min-height:118px;border:1px solid var(--fh-line);border-radius:12px;padding:16px;background:color-mix(in srgb,currentColor 2%,transparent);display:flex;flex-direction:column}.flowHubMetric strong{font:600 31px/1 ui-monospace,monospace}.flowHubMetric span{margin-top:13px;font-size:12px;font-weight:700}.flowHubMetric small{margin-top:4px;opacity:.5;font-size:10px}
        .flowHubPanel{border:1px solid var(--fh-line);border-radius:13px;padding:18px;margin-top:12px;background:color-mix(in srgb,currentColor 2%,transparent)}.flowHubPanel h4{margin:0 0 8px;font-size:14px}.flowHubPanel p{margin:0;opacity:.64;font-size:12px;line-height:1.65}.flowHubActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.flowHubButton{border:1px solid var(--fh-line);border-radius:8px;padding:8px 13px;background:transparent;color:inherit;cursor:pointer;font-weight:650}.flowHubButton:hover:not(:disabled){border-color:var(--fh-accent);transform:translateY(-1px)}.flowHubButton--primary{background:var(--fh-accent);border-color:var(--fh-accent);color:#21170e}.flowHubButton:disabled{opacity:.38;cursor:not-allowed}.flowHubPlan{margin-top:14px;border:1px solid color-mix(in srgb,var(--fh-accent) 45%,var(--fh-line));border-radius:11px;padding:14px}.flowHubPlan dl{display:grid;grid-template-columns:78px 1fr;gap:7px;margin:10px 0;font-size:11px}.flowHubPlan dt{opacity:.5}.flowHubPlan dd{margin:0;overflow-wrap:anywhere}
        .flowHubSearch{width:min(310px,100%);border:1px solid var(--fh-line);border-radius:9px;padding:9px 12px;background:transparent;color:inherit;outline:none}.flowHubSearch:focus{border-color:var(--fh-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--fh-accent) 13%,transparent)}.flowHubPluginLayout{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,.72fr);gap:12px}.flowHubList{display:grid;gap:7px;max-height:420px;overflow:auto;padding-right:3px}.flowHubPlugin{border:1px solid var(--fh-line);border-radius:10px;padding:13px 14px;background:transparent;color:inherit;text-align:left;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:8px}.flowHubPlugin:hover,.flowHubPlugin[aria-current=true]{border-color:color-mix(in srgb,var(--fh-accent) 55%,var(--fh-line));background:color-mix(in srgb,var(--fh-accent) 6%,transparent)}.flowHubPlugin strong{font-size:13px;overflow-wrap:anywhere}.flowHubPlugin small{display:block;margin-top:4px;opacity:.5}
        .flowHubPill{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:10px;font-weight:750}.flowHubPill i{width:6px;height:6px;border-radius:50%;background:#8b8b8b}.flowHubPill--passed i{background:var(--fh-green)}.flowHubPill--failed i{background:var(--fh-red)}.flowHubPill--stale i{background:var(--fh-accent)}.flowHubDetail{border:1px solid var(--fh-line);border-radius:12px;padding:17px;min-height:220px}.flowHubDetail h4{margin:0 0 5px;font-size:15px;overflow-wrap:anywhere}.flowHubDetail dl{display:grid;grid-template-columns:78px 1fr;gap:9px;margin:18px 0 0;font-size:11px}.flowHubDetail dt{opacity:.48}.flowHubDetail dd{margin:0;overflow-wrap:anywhere}.flowHubCode{font-family:ui-monospace,monospace;font-size:10px}
        .flowHubEmpty{display:grid;place-items:center;text-align:center;min-height:270px;border:1px dashed var(--fh-line);border-radius:13px;padding:28px}.flowHubEmpty b{font:600 22px/1.2 "Iowan Old Style","Noto Serif SC",serif}.flowHubEmpty p{max-width:440px;opacity:.58;font-size:12px;line-height:1.7}.flowHubTask{display:grid;grid-template-columns:90px 1fr auto;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--fh-line);font-size:11px}.flowHubTask:last-child{border-bottom:0}.flowHubAlert{margin-bottom:14px;border-left:3px solid var(--fh-red);padding:10px 12px;background:color-mix(in srgb,var(--fh-red) 8%,transparent);font-size:12px}.flowHubResult{margin-top:12px;border-left:3px solid var(--fh-green);padding:10px 12px;background:color-mix(in srgb,var(--fh-green) 8%,transparent);font-size:11px}.flowHubResult--bad{border-color:var(--fh-red)}.flowHubResult pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
        @container(max-width:760px){.flowHubTop{grid-template-columns:1fr;padding:22px}.flowHubStatus{justify-items:start}.flowHubBody{grid-template-columns:1fr}.flowHubNav{border-right:0;border-bottom:1px solid var(--fh-line);display:grid;grid-template-columns:repeat(5,minmax(86px,1fr));overflow:auto}.flowHubNav button{grid-template-columns:1fr;gap:3px;text-align:center;padding:9px 5px}.flowHubMain{padding:20px 16px}.flowHubGrid{grid-template-columns:1fr 1fr}.flowHubPluginLayout{grid-template-columns:1fr}.flowHubList{max-height:270px}.flowHubDetail{min-height:0}.flowHubSectionHead{align-items:start;flex-direction:column}.flowHubTask{grid-template-columns:72px 1fr}}
        @media(max-width:900px){.flowHubGrid{grid-template-columns:repeat(2,1fr)}.flowHubPluginLayout{grid-template-columns:1fr}.flowHubDetail{min-height:0}}@media(max-width:650px){.flowHubGrid{grid-template-columns:1fr}}@media(prefers-reduced-motion:no-preference){.flowHubMain>*{animation:fh-rise .28s ease both}@keyframes fh-rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}}
      `}</style>
      <header className="flowHubTop"><div><p className="flowHubKicker">DEEPSEEK HARNESS / FLOW HUB</p><h2 className="flowHubTitle">组装你的 Agent 工作台</h2><p className="flowHubSub">插件是能力，Flow 是经过验证的专家方案。所有发现、检查、安装与恢复都留在当前 DSH 界面。</p></div><div className="flowHubStatus"><b>{compatible ? '兼容，可执行' : bootstrap?.state === 'unknown' ? '版本未知，只读' : '不兼容，只读'}</b><span>DSH {bootstrap?.dshVersion ?? '—'} · Hub {bootstrap?.hubVersion ?? '—'}</span></div></header>
      <div className="flowHubBody">
        <nav className="flowHubNav" aria-label="Flow Hub 区域">{views.map(item => <button key={item.id} type="button" aria-selected={view === item.id} onClick={() => { setView(item.id) }}><small>{item.mark}</small><span>{item.label}</span></button>)}</nav>
        <main className="flowHubMain">
          {error ? <div className="flowHubAlert" role="alert">无法读取 Hub 数据：{error}</div> : null}
          {view === 'home' ? <><div className="flowHubSectionHead"><div><h3>可信能力地图</h3><p>Registry 只陈述证据，不把“被发现”包装成“已可信”。</p></div><button className="flowHubButton" type="button" onClick={refresh}>刷新状态</button></div><div className="flowHubGrid"><Metric value={registry?.plugins.length ?? '—'} label="候选插件" note={`Registry ${registry?.registryVersion ?? '载入中'}`} /><Metric value={verifiedCount} label="验证通过" note="完整运行证据" /><Metric value={failedCount} label="验证失败" note="失败同样公开" /><Metric value={registry?.flows.length ?? 0} label="专家 Flow" note="即将进入首发批次" /></div><div className="flowHubPanel"><h4>测试安装通道</h4><p>当前 Alpha 只允许固定的 hello bundle 进入写操作。兼容性不确定时，Bootstrap 会自动保持只读。</p><div className="flowHubActions"><button className="flowHubButton flowHubButton--primary" disabled={blocked || profiles[0]?.plugin.installed === true} onClick={() => { prepare('add') }}>{running === 'add' ? '生成计划中…' : profiles[0]?.plugin.installed ? '已安装' : '安装测试 Bundle'}</button><button className="flowHubButton" disabled={blocked || profiles[0]?.plugin.installed !== true} onClick={() => { prepare('update') }}>{running === 'update' ? '生成计划中…' : '更新'}</button><button className="flowHubButton" disabled={blocked || profiles[0]?.plugin.installed !== true} onClick={() => { prepare('remove') }}>{running === 'remove' ? '生成计划中…' : '卸载'}</button></div>{plan ? <PlanPreview plan={plan} running={running} execute={execute} cancel={() => { setPlan(null) }} /> : null}{result ? <div className={`flowHubResult${result.ok ? '' : ' flowHubResult--bad'}`} role="status"><b>{result.ok ? '事务成功' : '事务失败并已处理恢复'}</b><pre>{result.error ?? result.phases?.map(item => `${item.phase}: ${item.status}${item.detail ? ` (${item.detail})` : ''}`).join('\n') ?? '无阶段结果'}</pre></div> : null}</div></> : null}
          {view === 'plugins' ? <><div className="flowHubSectionHead"><div><h3>插件 Registry</h3><p>{plugins.length} 个结果 · 来源与验证状态始终可见</p></div><input className="flowHubSearch" aria-label="搜索插件" value={query} placeholder="搜索名称或许可证…" onChange={event => { setQuery(event.target.value) }} /></div><div className="flowHubPluginLayout"><div className="flowHubList">{plugins.map(plugin => <button className="flowHubPlugin" type="button" key={plugin.id} aria-current={selected === plugin.id} onClick={() => { setSelected(plugin.id) }}><span><strong>{plugin.package}</strong><small>{plugin.version} · {plugin.license ?? '许可证未知'}</small></span><StatePill state={plugin.verification.state} /></button>)}</div><aside className="flowHubDetail">{selectedPlugin ? <><StatePill state={selectedPlugin.verification.state} /><h4>{selectedPlugin.package}</h4><small>{selectedPlugin.id}</small><dl><dt>版本</dt><dd>{selectedPlugin.version}</dd><dt>来源</dt><dd className="flowHubCode">{selectedPlugin.source.spec}</dd><dt>完整性</dt><dd className="flowHubCode">{selectedPlugin.source.integrity ?? selectedPlugin.source.commit ?? '未披露'}</dd><dt>许可证</dt><dd>{selectedPlugin.license ?? '未披露'}</dd><dt>安装脚本</dt><dd>{Object.keys(selectedPlugin.lifecycleScripts).length ? Object.keys(selectedPlugin.lifecycleScripts).join('、') : '无披露脚本'}</dd><dt>权限</dt><dd>{selectedPlugin.permissions.length ? selectedPlugin.permissions.join('、') : '未声明额外权限'}</dd><dt>凭据</dt><dd>{selectedPlugin.credentials.length ? selectedPlugin.credentials.join('、') : '未声明凭据需求'}</dd><dt>环境</dt><dd>{selectedPlugin.verification.platform ?? '尚无运行证据'} {selectedPlugin.verification.dshVersion ?? ''}</dd></dl></> : <div className="flowHubEmpty"><div><b>选择一个插件</b><p>查看固定来源、许可证、生命周期脚本与验证环境。</p></div></div>}</aside></div></> : null}
          {view === 'flows' ? <><div className="flowHubSectionHead"><div><h3>Harness Flows</h3><p>完整的领域专家方案，而不是一串无上下文插件。</p></div></div><div className="flowHubEmpty"><div><b>首批专家 Flow 正在编译</b><p>Coding、Research 与 Design 将各自包含角色、插件组合、权限、Profile 和验收任务。</p></div></div></> : null}
          {view === 'profiles' ? <><div className="flowHubSectionHead"><div><h3>Profiles</h3><p>安装状态、来源和恢复点来自 Host，不依赖浏览器猜测。</p></div></div>{profiles.map(profile => <article className="flowHubPanel" key={profile.id}><h4>{profile.id} {profile.active ? '· 当前' : ''}</h4><p>{profile.plugin.installed ? `${profile.plugin.packageName} ${profile.plugin.version ?? '版本未知'} · ${profile.plugin.enabled ? '已启用' : '未启用'} · ${profile.plugin.source ?? '来源未知'}` : '测试 Bundle 未安装'}。由 {profile.managedBy} 管理。</p><div className="flowHubActions"><button className="flowHubButton" disabled={blocked || !profile.plugin.installed} onClick={() => { prepare('update'); setView('home') }}>更新预览</button><button className="flowHubButton" disabled={blocked || !profile.plugin.installed} onClick={() => { prepare('remove'); setView('home') }}>卸载预览</button><button className="flowHubButton" disabled title="等待 DSH 提供外部插件设置契约">设置</button><button className="flowHubButton" disabled title="等待 DSH 提供稳定启停契约">{profile.plugin.enabled ? '停用' : '启用'}</button></div><h4>恢复点</h4>{profile.recoveryPoints.length ? profile.recoveryPoints.map(point => <div className="flowHubTask" key={point.backupId}><b>{point.createdBy}</b><span>{new Date(point.createdAt).toLocaleString()} · <span className="flowHubCode">{point.backupId}</span></span><button className="flowHubButton" disabled={blocked} onClick={() => { prepareRollback(point.backupId) }}>回滚预览</button></div>) : <p>尚无可用恢复点。成功安装、更新、卸载或回滚后会保留恢复点。</p>}</article>)}</> : null}
          {view === 'tasks' ? <><div className="flowHubSectionHead"><div><h3>安装任务</h3><p>每一步都留下结果，失败不会被成功提示覆盖。</p></div></div><div className="flowHubPanel">{tasks.length ? tasks.map((task, index) => <div className="flowHubTask" key={`${task.startedAt ?? index}`}><b>{task.action ?? '任务'}</b><span>{task.startedAt ? new Date(task.startedAt).toLocaleString() : '时间未知'} · {task.phases?.map(item => item.phase).join(' → ')}</span><span>{task.ok ? '成功' : '已回滚'}</span></div>) : <div className="flowHubEmpty"><div><b>还没有安装任务</b><p>从总览发起测试安装后，结果会出现在这里。</p></div></div>}</div></> : null}
        </main>
      </div>
    </section>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'flow-hub', order: 20, label: () => 'Flow Hub' }, FlowHubTab))
}
