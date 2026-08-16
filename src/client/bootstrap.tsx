import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { buildBootstrapRecoveryGuidance, decideBootstrapRuntime } from '../bootstrap-policy.js'
import { FlowHubFullUI, type BootstrapResponse } from './index.js'

export const inject = ['slots']

function SafeRecovery({ bootstrap, failed, retry }: { bootstrap: BootstrapResponse | null, failed: boolean, retry: () => void }): ReactNode {
  const runtime = decideBootstrapRuntime(bootstrap, failed)
  const waiting = runtime.mode === 'loading'
  const guidance = buildBootstrapRecoveryGuidance(runtime, { profile: bootstrap?.profile, packageName: bootstrap?.hubPackageName, hubVersion: bootstrap?.hubVersion })
  const dimensions = bootstrap?.compatibility.dimensions
  const [copyStatus, setCopyStatus] = useState('')
  const copy = useCallback(async (command: string, label: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopyStatus(`${label}已复制`)
    } catch {
      setCopyStatus('复制失败，请手动选择命令')
    }
  }, [])
  return <section className="flowHubBootstrap" data-runtime-mode={runtime.mode}>
    <style>{`
      .flowHubBootstrap{--fh-accent:#e08a32;--fh-line:color-mix(in srgb,currentColor 14%,transparent);min-height:360px;border:1px solid var(--fh-line);border-radius:18px;padding:clamp(24px,5vw,48px);font-family:"Aptos","Noto Sans SC",sans-serif;color:inherit;background:radial-gradient(circle at 85% 0,color-mix(in srgb,var(--fh-accent) 14%,transparent),transparent 36%)}
      .flowHubBootstrap__kicker{margin:0 0 10px;font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.16em;color:var(--fh-accent)}.flowHubBootstrap__badge{display:inline-flex;margin:0 0 12px;border:1px solid var(--fh-line);border-radius:999px;padding:5px 9px;font:700 10px/1 ui-monospace,monospace;letter-spacing:.08em}.flowHubBootstrap h2{margin:0;font:600 clamp(26px,5vw,42px)/1.1 "Iowan Old Style","Noto Serif SC",serif}.flowHubBootstrap p,.flowHubBootstrap li{max-width:680px;font-size:13px;line-height:1.7}.flowHubBootstrap>p{opacity:.72}.flowHubBootstrap dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:9px;margin:24px 0;font-size:12px}.flowHubBootstrap dt{opacity:.52}.flowHubBootstrap dd{margin:0;overflow-wrap:anywhere}.flowHubBootstrap__card{margin-top:20px;padding:16px;border:1px solid var(--fh-line);border-radius:12px;background:color-mix(in srgb,currentColor 3%,transparent)}.flowHubBootstrap__card h3{margin:0 0 8px;font-size:15px}.flowHubBootstrap__card ol{margin:8px 0 16px;padding-left:20px}.flowHubBootstrap__command{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin-top:8px}.flowHubBootstrap code{display:block;padding:12px;border:1px solid var(--fh-line);border-radius:9px;font:11px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}.flowHubBootstrap__actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.flowHubBootstrap button{min-height:44px;border:1px solid var(--fh-line);border-radius:8px;padding:8px 14px;background:transparent;color:inherit;font-weight:650;cursor:pointer}.flowHubBootstrap button:focus-visible{outline:3px solid color-mix(in srgb,var(--fh-accent) 78%,white);outline-offset:2px}.flowHubBootstrap button:disabled{cursor:not-allowed;opacity:.5}@media(max-width:520px){.flowHubBootstrap__command{grid-template-columns:1fr}.flowHubBootstrap dl{grid-template-columns:1fr}.flowHubBootstrap dt{margin-top:6px}}
    `}</style>
    <p className="flowHubBootstrap__kicker">DEEPSEEK HARNESS / FLOW HUB BOOTSTRAP</p>
    <span className="flowHubBootstrap__badge">{guidance.badge === 'checking' ? '正在检查' : guidance.badge === 'read-only' ? '只读模式' : '不兼容模式'}</span>
    <h2>{guidance.title}</h2>
    <p>{waiting ? '正在读取 DSH 与 Hub 版本。完整市场、Profile 数据和事务模块尚未初始化。' : guidance.summary}</p>
    <dl><dt>DSH</dt><dd>{dimensions ? `${dimensions.dsh.actual ?? '未知'} · ${dimensions.dsh.state} · 支持 ${dimensions.dsh.supported}` : '未知'}</dd><dt>Hub</dt><dd>{dimensions ? `${dimensions.hub.actual ?? '未知'} · ${dimensions.hub.state} · 支持 ${dimensions.hub.supported}` : '未知'}</dd><dt>Registry Schema</dt><dd>{dimensions ? `${dimensions.registrySchema.actual ?? '未知'} · ${dimensions.registrySchema.state} · 支持 ${dimensions.registrySchema.supported}` : '未知'}</dd><dt>Flow Schema</dt><dd>{dimensions ? `${dimensions.flowSchema.actual ?? '未知'} · ${dimensions.flowSchema.state} · 支持 ${dimensions.flowSchema.supported}` : '未知'}</dd><dt>运行模式</dt><dd>{runtime.mode} · 只读</dd></dl>
    {!waiting ? <div className="flowHubBootstrap__card"><h3>更新与救援</h3><ol>{guidance.steps.map(step => <li key={step}>{step}</li>)}</ol>{guidance.updateCommand ? <div className="flowHubBootstrap__command"><code>{guidance.updateCommand}</code><button type="button" onClick={() => { void copy(guidance.updateCommand!, '更新命令') }}>复制更新命令</button></div> : null}{guidance.removeCommand ? <div className="flowHubBootstrap__command"><code>{guidance.removeCommand}</code><button type="button" onClick={() => { void copy(guidance.removeCommand!, '救援命令') }}>复制救援命令</button></div> : null}<p>命令只复制到剪贴板，不会由页面自动执行。移除 Hub 不会删除其他 DSH Profile。</p></div> : null}
    <div className="flowHubBootstrap__actions"><button type="button" disabled={waiting} onClick={retry}>{waiting ? '检查中…' : '重新检查兼容性'}</button></div>
    <p role="status" aria-live="polite">{copyStatus}</p>
  </section>
}

export function FlowHubBootstrapTab(): ReactNode {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const refresh = useCallback(() => {
    setBootstrap(null)
    setFailed(false)
    void fetch('/flow-hub/api/bootstrap', { cache: 'no-store' }).then(async response => {
      const body = await response.json() as BootstrapResponse
      if (!response.ok || !body.ok) throw new Error('bootstrap-unavailable')
      setBootstrap(body)
    }).catch(() => { setFailed(true) })
  }, [])
  useEffect(refresh, [refresh])
  const runtime = decideBootstrapRuntime(bootstrap, failed)
  if (runtime.loadFullUi && bootstrap !== null) return <FlowHubFullUI bootstrap={bootstrap} />
  return <SafeRecovery bootstrap={bootstrap} failed={failed} retry={refresh} />
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'flow-hub', order: 20, label: () => 'Flow Hub' }, FlowHubBootstrapTab))
}
