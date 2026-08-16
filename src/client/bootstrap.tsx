import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { decideBootstrapRuntime } from '../bootstrap-policy.js'
import { FlowHubFullUI, type BootstrapResponse } from './index.js'

export const inject = ['slots']

function SafeRecovery({ bootstrap, failed, retry }: { bootstrap: BootstrapResponse | null, failed: boolean, retry: () => void }): ReactNode {
  const runtime = decideBootstrapRuntime(bootstrap, failed)
  const waiting = runtime.mode === 'loading'
  const state = waiting ? '正在检查兼容性' : runtime.reason === 'version-incompatible' ? '版本不兼容' : runtime.reason === 'version-unknown' ? '版本尚未验证' : 'Bootstrap 不可用'
  return <section className="flowHubBootstrap" data-runtime-mode={runtime.mode}>
    <style>{`
      .flowHubBootstrap{--fh-accent:#e08a32;--fh-line:color-mix(in srgb,currentColor 14%,transparent);min-height:360px;border:1px solid var(--fh-line);border-radius:18px;padding:clamp(24px,5vw,48px);font-family:"Aptos","Noto Sans SC",sans-serif;color:inherit;background:radial-gradient(circle at 85% 0,color-mix(in srgb,var(--fh-accent) 14%,transparent),transparent 36%)}
      .flowHubBootstrap__kicker{margin:0 0 10px;font:700 10px/1.2 ui-monospace,monospace;letter-spacing:.16em;color:var(--fh-accent)}.flowHubBootstrap h2{margin:0;font:600 clamp(26px,5vw,42px)/1.1 "Iowan Old Style","Noto Serif SC",serif}.flowHubBootstrap p{max-width:680px;font-size:13px;line-height:1.7;opacity:.7}.flowHubBootstrap dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:9px;margin:24px 0;font-size:12px}.flowHubBootstrap dt{opacity:.52}.flowHubBootstrap dd{margin:0;overflow-wrap:anywhere}.flowHubBootstrap code{display:block;margin-top:16px;padding:12px;border:1px solid var(--fh-line);border-radius:9px;font:11px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}.flowHubBootstrap button{min-height:44px;border:1px solid var(--fh-line);border-radius:8px;padding:8px 14px;background:transparent;color:inherit;font-weight:650;cursor:pointer}.flowHubBootstrap button:focus-visible{outline:3px solid color-mix(in srgb,var(--fh-accent) 78%,white);outline-offset:2px}
    `}</style>
    <p className="flowHubBootstrap__kicker">DEEPSEEK HARNESS / FLOW HUB BOOTSTRAP</p>
    <h2>{state}</h2>
    <p>{waiting ? '正在读取 DSH 与 Hub 版本。完整市场、Profile 数据和事务模块尚未初始化。' : '完整 Flow Hub 已保持关闭；不会读取 Registry，也不会发起安装、更新、卸载或回滚。你仍可在当前 DSH 页面查看恢复方法。'}</p>
    <dl><dt>DSH</dt><dd>{bootstrap?.dshVersion ?? '未知'}</dd><dt>Hub</dt><dd>{bootstrap?.hubVersion ?? '未知'}</dd><dt>支持范围</dt><dd>{bootstrap?.supported ?? '无法读取'}</dd><dt>运行模式</dt><dd>{runtime.mode} · 只读</dd></dl>
    <b>CLI 救援命令</b>
    <code>dsh plugin --profile web remove @harness-flow/dsh-flow-hub</code>
    <p><button type="button" disabled={waiting} onClick={retry}>{waiting ? '检查中…' : '重新检查兼容性'}</button></p>
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
