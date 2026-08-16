export type BootstrapCompatibilityState = 'compatible' | 'unknown' | 'incompatible'
export type BootstrapRuntimeMode = 'loading' | 'full-ui' | 'safe-recovery'

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
  return {
    mode: 'safe-recovery',
    loadFullUi: false,
    allowMutations: false,
    initialEndpoints: bootstrapOnly,
    reason: snapshot.state === 'incompatible' ? 'version-incompatible' : 'version-unknown',
  }
}
