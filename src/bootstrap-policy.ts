export type BootstrapCompatibilityState = 'compatible' | 'unknown' | 'incompatible'
export type BootstrapRuntimeMode = 'loading' | 'full-ui' | 'read-only' | 'safe-recovery'

export interface BootstrapSnapshot {
  ok: boolean
  state: BootstrapCompatibilityState
}

export interface BootstrapRuntimePlan {
  mode: BootstrapRuntimeMode
  loadFullUi: boolean
  allowMutations: boolean
  initialEndpoints: readonly string[]
  reason: 'bootstrap-pending' | 'compatible' | 'bootstrap-unavailable' | 'version-unknown' | 'version-incompatible'
}

export interface BootstrapRecoveryGuidance {
  badge: 'checking' | 'read-only' | 'recovery'
  title: string
  summary: string
  updateCommand: string | null
  removeCommand: string | null
  steps: readonly string[]
}

export interface BootstrapRecoveryOptions {
  profile?: string | null
  packageName?: string | null
  hubVersion?: string | null
}

const bootstrapOnly = ['/flow-hub/api/bootstrap'] as const
const fullUiReads = ['/flow-hub/api/registry', '/flow-hub/api/profiles', '/flow-hub/api/tasks', '/flow-hub/api/flows'] as const

export function decideBootstrapRuntime(snapshot: BootstrapSnapshot | null, bootstrapFailed = false): BootstrapRuntimePlan {
  if (bootstrapFailed) {
    return { mode: 'safe-recovery', loadFullUi: false, allowMutations: false, initialEndpoints: bootstrapOnly, reason: 'bootstrap-unavailable' }
  }
  if (snapshot === null) {
    return { mode: 'loading', loadFullUi: false, allowMutations: false, initialEndpoints: bootstrapOnly, reason: 'bootstrap-pending' }
  }
  if (snapshot.ok && snapshot.state === 'compatible') {
    return { mode: 'full-ui', loadFullUi: true, allowMutations: true, initialEndpoints: fullUiReads, reason: 'compatible' }
  }
  if (!snapshot.ok) {
    return { mode: 'safe-recovery', loadFullUi: false, allowMutations: false, initialEndpoints: bootstrapOnly, reason: 'bootstrap-unavailable' }
  }
  return {
    mode: snapshot.state === 'unknown' ? 'read-only' : 'safe-recovery',
    loadFullUi: false,
    allowMutations: false,
    initialEndpoints: bootstrapOnly,
    reason: snapshot.state === 'incompatible' ? 'version-incompatible' : 'version-unknown',
  }
}

function safeProfile(value: string | null | undefined): string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) ? value : 'web'
}

function safePackage(value: string | null | undefined): string {
  return typeof value === 'string' && /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
    ? value
    : '@harness-flow/dsh-flow-hub'
}

export function buildBootstrapRecoveryGuidance(runtime: BootstrapRuntimePlan, options: BootstrapRecoveryOptions = {}): BootstrapRecoveryGuidance {
  if (runtime.mode === 'loading') {
    return {
      badge: 'checking', title: '正在检查兼容性', summary: '完整 Flow Hub 尚未初始化。',
      updateCommand: null, removeCommand: null, steps: ['等待 Bootstrap 返回四维兼容状态。'],
    }
  }
  if (runtime.mode === 'full-ui') {
    return {
      badge: 'checking', title: '当前组合已验证', summary: '可以加载完整 Flow Hub。',
      updateCommand: null, removeCommand: null, steps: [],
    }
  }

  const profile = safeProfile(options.profile)
  const packageName = safePackage(options.packageName)
  const updateCommand = `dsh plugin --profile ${profile} update ${packageName}`
  const removeCommand = `dsh plugin --profile ${profile} remove ${packageName}`
  const version = options.hubVersion?.trim() ? `当前 Hub ${options.hubVersion.trim()}。` : ''

  if (runtime.mode === 'read-only') {
    return {
      badge: 'read-only',
      title: '当前组合尚未验证',
      summary: `${version}在兼容矩阵确认前保持只读；不会读取 Registry 或修改 Profile。`,
      updateCommand,
      removeCommand,
      steps: ['重新检查兼容状态。', '如已发布兼容 Hub，复制更新命令并在本机终端执行。', '如 DSH 使用受影响，复制移除命令进入救援。'],
    }
  }

  return {
    badge: 'recovery',
    title: runtime.reason === 'version-incompatible' ? '当前组合不兼容' : '无法确认兼容状态',
    summary: `${version}危险模块和所有 Profile 写操作已关闭；DSH Web 与本地救援路径保持可用。`,
    updateCommand,
    removeCommand,
    steps: ['先重新检查兼容状态。', '复制更新命令，安装支持当前 DSH 的 Hub 版本。', '若更新后仍无法恢复，复制移除命令；该操作只移除 Flow Hub。'],
  }
}
