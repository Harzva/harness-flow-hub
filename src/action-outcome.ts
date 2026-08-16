export interface ActionPhaseResult {
  phase: string
  status: 'passed' | 'failed' | 'skipped'
  detail?: string
}

export interface ActionOutcomeInput {
  ok: boolean
  action?: string
  profile?: string
  phases?: ActionPhaseResult[]
  error?: string
}

export interface UserActionOutcome {
  state: 'success' | 'rolled-back' | 'recovery-required' | 'unknown'
  title: string
  happened: string
  rollback: string
  next: string
  taskLabel: string
}

const phaseLabels: Record<string, string> = {
  preflight: '兼容性预检',
  snapshot: 'Profile 快照',
  staging: '暂存准备',
  install: '插件安装',
  'dump-config': '配置检查',
  commit: '原子提交',
  relink: '依赖重连',
  health: '健康检查',
  complete: '完成确认',
  rollback: '自动回滚',
}

const actionLabels: Record<string, string> = {
  add: '安装',
  update: '更新',
  remove: '卸载',
  rollback: '恢复',
}

function reasonLabel(value: string | undefined): string {
  if (!value) return '未收到可确认的失败原因'
  if (value.startsWith('injected-failure:')) return '隔离测试按计划触发了故障'
  if (value.startsWith('unsupported-dsh-version:')) return '当前 DSH 版本不在支持范围内'
  if (value.startsWith('unsupported-platform:')) return '当前操作系统不在支持范围内'
  if (value.startsWith('network-preflight-failed:')) return '网络预检未通过'
  if (value === 'insufficient-disk-space') return '可用磁盘空间不足'
  if (value.startsWith('missing-credentials:')) return '缺少插件声明的必要凭据'
  if (value === 'profile-transaction-locked' || value === 'transaction-in-progress') return '同一 Profile 已有任务正在执行'
  if (value.includes('dump-config')) return 'DSH 配置检查未通过'
  if (value.includes('health')) return '提交后的健康检查未通过'
  if (value.includes('install')) return '插件安装阶段未通过'
  if (value.includes('relink')) return '最终 Profile 的依赖重连未通过'
  return '详细错误已保留在本机任务记录中，为避免泄露路径或凭据不在此展开'
}

export function summarizeActionOutcome(result: ActionOutcomeInput): UserActionOutcome {
  const action = actionLabels[result.action ?? ''] ?? '操作'
  const profile = result.profile ? ` Profile ${result.profile}` : '当前 Profile'
  if (result.ok) return {
    state: 'success',
    title: `${action}成功`,
    happened: `${profile} 已完成${action}并通过健康检查。`,
    rollback: '没有发生失败，无需回滚。',
    next: '可前往 Profiles 检查当前版本与恢复点。',
    taskLabel: '成功',
  }

  const failed = result.phases?.find(item => item.status === 'failed' && item.phase !== 'rollback')
  const rollback = result.phases?.find(item => item.phase === 'rollback')
  const phase = failed ? phaseLabels[failed.phase] ?? failed.phase : null
  const reason = reasonLabel(result.error ?? failed?.detail)
  const happened = phase ? `${action}在“${phase}”阶段停止：${reason}。` : `${action}结果未能确认：${reason}。`

  if (rollback?.status === 'passed') return {
    state: 'rolled-back',
    title: `${action}失败，原 Profile 已恢复`,
    happened,
    rollback: '自动回滚已通过；原 Profile 保持原状态或已从快照恢复。',
    next: '先刷新状态；需要重试时重新生成计划并再次核对风险。',
    taskLabel: '已回滚',
  }

  if (rollback?.status === 'failed') return {
    state: 'recovery-required',
    title: `${action}失败，自动恢复未完成`,
    happened,
    rollback: '自动回滚失败，不能假设原 Profile 已恢复。',
    next: '不要继续修改该 Profile；前往 Profiles 选择已有恢复点。若 DSH UI 无法恢复，再使用 Bootstrap 提供的 CLI 救援命令。',
    taskLabel: '需要恢复',
  }

  return {
    state: 'unknown',
    title: `${action}结果未知，需要检查`,
    happened,
    rollback: '没有收到可验证的回滚结果，不能假设已经恢复。',
    next: '刷新状态并检查安装任务与 Profiles；确认没有运行中的任务后再决定是否重试。',
    taskLabel: '状态待确认',
  }
}
