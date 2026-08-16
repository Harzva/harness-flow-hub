import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FlowInstallPlan, StackLock } from './flow-resolver.js'

export type PluginAction = 'add' | 'update' | 'remove'
export type TransactionAction = PluginAction | 'rollback'
export type SourceKind = 'npm' | 'tgz' | 'github-sha' | 'local-directory'
export type TransactionPhase = 'preflight' | 'snapshot' | 'staging' | 'install' | 'dump-config' | 'commit' | 'relink' | 'health' | 'rollback' | 'complete'

export interface InstallPlan {
  schemaVersion: 1
  id: string
  createdAt: string
  expiresAt: string
  action: PluginAction
  profile: string
  packageName: string
  source: { kind: SourceKind, spec: string }
  artifact: {
    version: string
    integrity: string
    lifecycleScripts: string[]
  }
  requirements: {
    dshVersion: string
    platforms: string[]
    network: { required: boolean, endpoint?: string }
  }
  risk: {
    lifecycleScriptsDisabled: true
    permissions: string[]
    credentials: string[]
    verification: string
    signature: 'verified' | 'not-applicable-trusted-fixture' | 'unverified'
  }
  phases: TransactionPhase[]
}

export interface RollbackPlan {
  schemaVersion: 1
  id: string
  createdAt: string
  expiresAt: string
  action: 'rollback'
  profile: string
  backupId: string
  requirements: { dshVersion: string, platforms: string[] }
  phases: TransactionPhase[]
}

export interface RecoveryPoint {
  backupId: string
  profile: string
  createdAt: string
  createdBy: TransactionAction
}

export interface PhaseResult { phase: TransactionPhase, status: 'passed' | 'failed' | 'skipped', detail?: string }
export interface PreflightReport {
  platform: string
  architecture: string
  dshVersion: string
  freeBytes: number
  network: 'passed' | 'not-required'
  credentials: 'passed' | 'not-required'
  signature: 'verified' | 'not-applicable-trusted-fixture'
  sourceExact: true
}
export interface TransactionResult {
  ok: boolean
  planId: string
  action: TransactionAction
  profile: string
  phases: PhaseResult[]
  preflight?: PreflightReport
  backupId?: string
  error?: string
  startedAt: string
  finishedAt: string
}

interface CommandResult { code: number | null, stdout: string, stderr: string }
export interface TransactionOptions {
  home?: string
  dshCli: string
  now?: () => Date
  run?: (args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>
  minimumFreeBytes?: number
  failAt?: TransactionPhase
  dshVersion?: string
  runtimePlatform?: string
  runtimeArch?: string
  availableCredentials?: string[]
  networkProbe?: (endpoint: string) => Promise<boolean>
}

export type FlowTransactionStep = FlowInstallPlan['steps'][number] | 'rollback'
export interface FlowTransactionResult {
  ok: boolean
  planId: string
  action: 'install-flow'
  profile: string
  steps: Array<{ step: FlowTransactionStep, status: 'passed' | 'failed', detail?: string }>
  stackLockPath?: string
  error?: string
  startedAt: string
  finishedAt: string
}
export interface FlowTransactionOptions extends Omit<TransactionOptions, 'failAt'> {
  failAt?: FlowInstallPlan['steps'][number]
  bootSmoke: (profile: string, env: NodeJS.ProcessEnv) => Promise<CommandResult>
}

interface TransactionJournal {
  schemaVersion: 1
  plan: InstallPlan | RollbackPlan
  pid: number
  status: 'started' | 'staged' | 'original-moved' | 'committed' | 'complete' | 'rolled-back' | 'recovered'
  updatedAt: string
}

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const PLAN_TTL_MS = 5 * 60_000

function dshHome(configured?: string): string {
  const selected = configured ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  return resolve(selected)
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function safeProfile(name: string): void {
  if (!PROFILE_NAME.test(name) || name === 'node_modules' || name === '.' || name === '..') throw new Error('invalid-profile')
}

export function inferSourceKind(spec: string): SourceKind {
  if (/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[a-f0-9]{40}$/.test(spec)) return 'github-sha'
  if (/\.tgz$/i.test(spec) || spec.startsWith('file:') && /\.tgz$/i.test(spec.slice(5))) return 'tgz'
  if (/^(?:link:|file:)?(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/.test(spec)) return 'local-directory'
  if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec)) return 'npm'
  throw new Error('source-must-be-exact')
}

export function createInstallPlan(input: {
  action: PluginAction, profile: string, packageName: string, sourceSpec: string,
  version?: string, integrity?: string, lifecycleScripts?: string[],
  permissions?: string[], credentials?: string[], verification?: string,
  signature?: InstallPlan['risk']['signature'], dshVersion?: string, platforms?: string[], networkEndpoint?: string, now?: Date,
}): InstallPlan {
  safeProfile(input.profile)
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(input.packageName)) throw new Error('invalid-package-name')
  const source = { kind: inferSourceKind(input.sourceSpec), spec: input.sourceSpec }
  const networkRequired = source.kind === 'npm' || source.kind === 'github-sha'
  const version = input.version?.trim() || 'not-disclosed'
  const integrity = input.integrity?.trim() || 'not-disclosed'
  const now = input.now ?? new Date()
  const body = {
    schemaVersion: 1 as const,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    action: input.action,
    profile: input.profile,
    packageName: input.packageName,
    source,
    artifact: {
      version,
      integrity,
      lifecycleScripts: [...(input.lifecycleScripts ?? [])],
    },
    requirements: {
      dshVersion: input.dshVersion ?? '>=0.1.0-rc.6 <0.2.0',
      platforms: [...(input.platforms ?? ['win32', 'linux', 'darwin'])],
      network: {
        required: networkRequired,
        ...(networkRequired ? { endpoint: input.networkEndpoint ?? (source.kind === 'npm' ? 'https://registry.npmjs.org/' : 'https://github.com/') } : {}),
      },
    },
    risk: {
      lifecycleScriptsDisabled: true as const,
      permissions: [...(input.permissions ?? [])],
      credentials: [...(input.credentials ?? [])],
      verification: input.verification ?? 'unverified',
      signature: input.signature ?? 'unverified',
    },
    phases: ['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'relink', 'health', 'complete'] as TransactionPhase[],
  }
  const id = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)
  return { ...body, id }
}

export function createRollbackPlan(input: { profile: string, backupId: string, dshVersion?: string, platforms?: string[], now?: Date }): RollbackPlan {
  safeProfile(input.profile)
  if (!/^[a-f0-9]{24}$/.test(input.backupId)) throw new Error('invalid-backup-id')
  const now = input.now ?? new Date()
  const body = {
    schemaVersion: 1 as const,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    action: 'rollback' as const,
    profile: input.profile,
    backupId: input.backupId,
    requirements: { dshVersion: input.dshVersion ?? '>=0.1.0-rc.6 <0.2.0', platforms: [...(input.platforms ?? ['win32', 'linux', 'darwin'])] },
    phases: ['preflight', 'staging', 'dump-config', 'commit', 'relink', 'health', 'complete'] as TransactionPhase[],
  }
  const id = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)
  return { ...body, id }
}

function compatibleDshVersion(version: string, range: string): boolean {
  if (range !== '>=0.1.0-rc.6 <0.2.0') return false
  const match = /^0\.1\.(\d+)(?:-rc\.(\d+))?$/.exec(version)
  if (match === null) return false
  return Number(match[1]) > 0 || match[2] === undefined || Number(match[2]) >= 6
}

function detectedDshVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require(require.resolve('@deepseek-ai/dsh/package.json')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

async function defaultNetworkProbe(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(5_000) })
    return response.ok || response.status === 401 || response.status === 403 || response.status === 405
  } catch {
    return false
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
}

function journalFor(plan: InstallPlan | RollbackPlan, status: TransactionJournal['status'], now: Date): TransactionJournal {
  return { schemaVersion: 1, plan, pid: process.pid, status, updatedAt: now.toISOString() }
}

export async function listRecoveryPoints(options: { home?: string, profile: string }): Promise<RecoveryPoint[]> {
  safeProfile(options.profile)
  const home = dshHome(options.home)
  const journalsRoot = join(home, 'flow-hub', 'transactions')
  let names: string[]
  try { names = await readdir(journalsRoot) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const points: RecoveryPoint[] = []
  for (const name of names.filter(value => /^[a-f0-9]{24}\.json$/.test(value))) {
    try {
      const journal = JSON.parse(await readFile(join(journalsRoot, name), 'utf8')) as TransactionJournal
      if (journal.schemaVersion !== 1 || journal.status !== 'complete' || journal.plan.profile !== options.profile) continue
      if (`${journal.plan.id}.json` !== name) continue
      const backupDir = join(home, 'flow-hub', 'backups', journal.plan.id, options.profile)
      if (!inside(home, backupDir) || !await exists(join(backupDir, 'package.json'))) continue
      points.push({ backupId: journal.plan.id, profile: options.profile, createdAt: journal.plan.createdAt, createdBy: journal.plan.action })
    } catch {
      continue
    }
  }
  return points.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function recoverInterruptedTransactions(options: { home?: string, now?: () => Date, isProcessAlive?: (pid: number) => boolean } = {}): Promise<TransactionResult[]> {
  const home = dshHome(options.home)
  const journalsRoot = join(home, 'flow-hub', 'transactions')
  let names: string[]
  try { names = await readdir(journalsRoot) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const results: TransactionResult[] = []
  for (const name of names.filter(value => /^[a-f0-9]{24}\.json$/.test(value))) {
    const journalPath = join(journalsRoot, name)
    let journal: TransactionJournal
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as TransactionJournal } catch { continue }
    if (journal.schemaVersion !== 1 || ['complete', 'rolled-back', 'recovered'].includes(journal.status)) continue
    if ((options.isProcessAlive ?? processAlive)(journal.pid)) continue
    const plan = journal.plan
    try { safeProfile(plan.profile) } catch { continue }
    if (`${plan.id}.json` !== name) continue
    const profileDir = join(home, 'profiles', plan.profile)
    const stageDir = join(home, 'profiles', `flow-hub-stage-${plan.id}`)
    const backupDir = join(home, 'flow-hub', 'backups', plan.id, plan.profile)
    const failedDir = join(home, 'flow-hub', 'failed', plan.id)
    const lockDir = join(home, 'flow-hub', 'locks', `${plan.profile}.lock`)
    if (![profileDir, stageDir, backupDir, failedDir, lockDir].every(target => inside(home, target))) continue
    const startedAt = journal.updatedAt
    const phases: PhaseResult[] = []
    try {
      const backupExists = await exists(backupDir)
      const profileExists = await exists(profileDir)
      if (backupExists) {
        if (profileExists) {
          await mkdir(dirname(failedDir), { recursive: true })
          await rm(failedDir, { recursive: true, force: true })
          await rename(profileDir, failedDir)
        }
        await rename(backupDir, profileDir)
        phases.push({ phase: 'rollback', status: 'passed', detail: `interrupted-profile-restored=${plan.id}` })
      } else {
        phases.push({ phase: 'rollback', status: 'passed', detail: 'interrupted-precommit-stage-removed' })
      }
      await rm(stageDir, { recursive: true, force: true })
      await rm(lockDir, { recursive: true, force: true })
      await atomicJson(journalPath, { ...journal, status: 'recovered', updatedAt: (options.now?.() ?? new Date()).toISOString() })
      results.push({ ok: false, planId: plan.id, action: plan.action, profile: plan.profile, phases, error: 'interrupted-transaction-recovered', startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() })
    } catch (error) {
      results.push({ ok: false, planId: plan.id, action: plan.action, profile: plan.profile, phases: [{ phase: 'rollback', status: 'failed', detail: error instanceof Error ? error.message : String(error) }], error: 'interrupted-transaction-recovery-failed', startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() })
    }
  }
  return results
}

async function defaultRun(dshCli: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return await new Promise(resolveResult => {
    const child = spawn(process.execPath, [dshCli, ...args], { shell: false, windowsHide: true, env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', value => { stdout += String(value) })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += String(value) })
    child.on('error', error => { resolveResult({ code: null, stdout, stderr: `${stderr}${error.message}` }) })
    child.on('close', code => { resolveResult({ code, stdout, stderr }) })
  })
}

async function copyProfileControl(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', '.npmrc']) {
    const from = join(source, name)
    try {
      if ((await stat(from)).isFile()) await cp(from, join(target, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function commandFor(plan: InstallPlan, stageProfile: string): string[] {
  const base = ['plugin', '--profile', stageProfile]
  if (plan.action === 'remove') return [...base, 'remove', plan.packageName, '--reporter=silent']
  return [...base, 'add', plan.source.spec, '--save-exact', '--ignore-scripts', '--reporter=silent']
}

export async function executeInstallPlan(plan: InstallPlan, options: TransactionOptions): Promise<TransactionResult> {
  const startedAt = (options.now?.() ?? new Date()).toISOString()
  const phases: PhaseResult[] = []
  const home = dshHome(options.home)
  const profilesRoot = join(home, 'profiles')
  const stateRoot = join(home, 'flow-hub')
  const profileDir = join(profilesRoot, plan.profile)
  const stageProfile = `flow-hub-stage-${plan.id}`
  const stageDir = join(profilesRoot, stageProfile)
  const snapshotDir = join(stateRoot, 'snapshots', plan.id)
  const backupDir = join(stateRoot, 'backups', plan.id, plan.profile)
  const lockDir = join(stateRoot, 'locks', `${plan.profile}.lock`)
  const failedDir = join(stateRoot, 'failed', plan.id)
  const journalPath = join(stateRoot, 'transactions', `${plan.id}.json`)
  const run = options.run ?? ((args, env) => defaultRun(options.dshCli, args, env))
  let locked = false
  let committed = false
  let preflight: PreflightReport | undefined
  const pass = (phase: TransactionPhase, detail?: string): void => { phases.push({ phase, status: 'passed', ...(detail ? { detail } : {}) }) }
  const failPoint = (phase: TransactionPhase): void => { if (options.failAt === phase) throw new Error(`injected-failure:${phase}`) }
  try {
    safeProfile(plan.profile)
    if (Date.parse(plan.expiresAt) <= Date.parse(startedAt)) throw new Error('install-plan-expired')
    for (const target of [profileDir, stageDir, snapshotDir, backupDir, lockDir, failedDir, journalPath]) {
      if (!inside(home, target)) throw new Error('transaction-path-outside-dsh-home')
    }
    await mkdir(dirname(lockDir), { recursive: true })
    try { await mkdir(lockDir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('profile-transaction-locked')
      throw error
    }
    locked = true
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ planId: plan.id, startedAt }) + '\n', 'utf8')
    await atomicJson(journalPath, journalFor(plan, 'started', options.now?.() ?? new Date()))
    if (!(await stat(join(profileDir, 'package.json'))).isFile()) throw new Error('profile-not-initialized')
    const actualPlatform = options.runtimePlatform ?? platform()
    const actualArch = options.runtimeArch ?? arch()
    if (!plan.requirements.platforms.includes(actualPlatform)) throw new Error(`unsupported-platform:${actualPlatform}`)
    const actualDshVersion = options.dshVersion ?? detectedDshVersion()
    if (actualDshVersion === null) throw new Error('dsh-version-unknown')
    if (!compatibleDshVersion(actualDshVersion, plan.requirements.dshVersion)) throw new Error(`unsupported-dsh-version:${actualDshVersion}`)
    const disk = await statfs(home)
    const free = Number(disk.bavail) * Number(disk.bsize)
    if (free < (options.minimumFreeBytes ?? 128 * 1024 * 1024)) throw new Error('insufficient-disk-space')
    const availableCredentials = new Set(options.availableCredentials ?? Object.keys(process.env).filter(name => Boolean(process.env[name])))
    const missingCredentials = plan.risk.credentials.filter(name => !availableCredentials.has(name))
    if (missingCredentials.length > 0) throw new Error(`missing-credentials:${missingCredentials.join(',')}`)
    if (plan.risk.signature === 'unverified') throw new Error('registry-signature-unverified')
    let network: PreflightReport['network'] = 'not-required'
    if (plan.requirements.network.required) {
      const endpoint = plan.requirements.network.endpoint
      if (endpoint === undefined || !await (options.networkProbe ?? defaultNetworkProbe)(endpoint)) throw new Error('network-preflight-failed')
      network = 'passed'
    }
    preflight = {
      platform: actualPlatform, architecture: actualArch, dshVersion: actualDshVersion, freeBytes: free,
      network, credentials: plan.risk.credentials.length ? 'passed' : 'not-required', signature: plan.risk.signature,
      sourceExact: true,
    }
    failPoint('preflight'); pass('preflight', `source=${plan.source.kind}; platform=${actualPlatform}/${actualArch}; dsh=${actualDshVersion}; network=${network}; signature=${plan.risk.signature}; scripts=disabled`)

    await copyProfileControl(profileDir, snapshotDir)
    await writeFile(join(snapshotDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8')
    failPoint('snapshot'); pass('snapshot', `snapshot=${plan.id}`)

    await rm(stageDir, { recursive: true, force: true })
    await copyProfileControl(profileDir, stageDir)
    await atomicJson(journalPath, journalFor(plan, 'staged', options.now?.() ?? new Date()))
    failPoint('staging'); pass('staging', `profile=${stageProfile}`)

    const install = await run(commandFor(plan, stageProfile), { ...process.env, DSH_HOME: home })
    if (install.code !== 0) throw new Error(`plugin-command-failed:${install.code ?? 'spawn'}`)
    failPoint('install'); pass('install')

    const stagedDump = await run(['--profile', stageProfile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (stagedDump.code !== 0) throw new Error(`staged-dump-config-failed:${stagedDump.code ?? 'spawn'}`)
    failPoint('dump-config'); pass('dump-config')

    await rm(join(stageDir, 'node_modules'), { recursive: true, force: true })
    await mkdir(dirname(backupDir), { recursive: true })
    await rename(profileDir, backupDir)
    await atomicJson(journalPath, journalFor(plan, 'original-moved', options.now?.() ?? new Date()))
    try { await rename(stageDir, profileDir) } catch (error) {
      await rename(backupDir, profileDir)
      throw error
    }
    committed = true
    await atomicJson(journalPath, journalFor(plan, 'committed', options.now?.() ?? new Date()))
    failPoint('commit'); pass('commit', `backup=${plan.id}`)

    const relink = await run(['plugin', '--profile', plan.profile, 'install', '--ignore-scripts', '--reporter=silent'], { ...process.env, DSH_HOME: home })
    if (relink.code !== 0) throw new Error(`final-profile-relink-failed:${relink.code ?? 'spawn'}`)
    failPoint('relink'); pass('relink', 'official plugin install rebuilt final-path dependencies')

    const health = await run(['--profile', plan.profile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (health.code !== 0) throw new Error(`committed-profile-health-failed:${health.code ?? 'spawn'}`)
    failPoint('health'); pass('health', 'official dump-config passed')
    failPoint('complete')
    pass('complete')
    await atomicJson(journalPath, journalFor(plan, 'complete', options.now?.() ?? new Date()))
    return { ok: true, planId: plan.id, action: plan.action, profile: plan.profile, phases, preflight, backupId: plan.id, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failedPhase = plan.phases.find(phase => !phases.some(result => result.phase === phase)) ?? 'preflight'
    phases.push({ phase: failedPhase, status: 'failed', detail: message })
    if (committed) {
      try {
        await mkdir(dirname(failedDir), { recursive: true })
        await rename(profileDir, failedDir)
        await rename(backupDir, profileDir)
        phases.push({ phase: 'rollback', status: 'passed', detail: `restored=${plan.id}` })
      } catch (rollbackError) {
        phases.push({ phase: 'rollback', status: 'failed', detail: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) })
      }
    } else {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {})
      phases.push({ phase: 'rollback', status: 'passed', detail: 'original-profile-untouched' })
    }
    await atomicJson(journalPath, journalFor(plan, 'rolled-back', options.now?.() ?? new Date())).catch(() => {})
    return { ok: false, planId: plan.id, action: plan.action, profile: plan.profile, phases, preflight, error: message, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } finally {
    if (locked) await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function executeRollbackPlan(plan: RollbackPlan, options: TransactionOptions): Promise<TransactionResult> {
  const startedAt = (options.now?.() ?? new Date()).toISOString()
  const phases: PhaseResult[] = []
  const home = dshHome(options.home)
  const profilesRoot = join(home, 'profiles')
  const stateRoot = join(home, 'flow-hub')
  const profileDir = join(profilesRoot, plan.profile)
  const sourceBackupDir = join(stateRoot, 'backups', plan.backupId, plan.profile)
  const stageProfile = `flow-hub-stage-${plan.id}`
  const stageDir = join(profilesRoot, stageProfile)
  const undoBackupDir = join(stateRoot, 'backups', plan.id, plan.profile)
  const lockDir = join(stateRoot, 'locks', `${plan.profile}.lock`)
  const failedDir = join(stateRoot, 'failed', plan.id)
  const journalPath = join(stateRoot, 'transactions', `${plan.id}.json`)
  const run = options.run ?? ((args, env) => defaultRun(options.dshCli, args, env))
  let locked = false
  let committed = false
  const pass = (phase: TransactionPhase, detail?: string): void => { phases.push({ phase, status: 'passed', ...(detail ? { detail } : {}) }) }
  const failPoint = (phase: TransactionPhase): void => { if (options.failAt === phase) throw new Error(`injected-failure:${phase}`) }
  try {
    safeProfile(plan.profile)
    if (!/^[a-f0-9]{24}$/.test(plan.backupId)) throw new Error('invalid-backup-id')
    if (Date.parse(plan.expiresAt) <= Date.parse(startedAt)) throw new Error('rollback-plan-expired')
    for (const target of [profileDir, sourceBackupDir, stageDir, undoBackupDir, lockDir, failedDir, journalPath]) {
      if (!inside(home, target)) throw new Error('transaction-path-outside-dsh-home')
    }
    await mkdir(dirname(lockDir), { recursive: true })
    try { await mkdir(lockDir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('profile-transaction-locked')
      throw error
    }
    locked = true
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ planId: plan.id, startedAt }) + '\n', 'utf8')
    await atomicJson(journalPath, journalFor(plan, 'started', options.now?.() ?? new Date()))
    if (!await exists(join(profileDir, 'package.json'))) throw new Error('profile-not-initialized')
    if (!await exists(join(sourceBackupDir, 'package.json'))) throw new Error('recovery-point-missing')
    const actualPlatform = options.runtimePlatform ?? platform()
    if (!plan.requirements.platforms.includes(actualPlatform)) throw new Error(`unsupported-platform:${actualPlatform}`)
    const actualDshVersion = options.dshVersion ?? detectedDshVersion()
    if (actualDshVersion === null) throw new Error('dsh-version-unknown')
    if (!compatibleDshVersion(actualDshVersion, plan.requirements.dshVersion)) throw new Error(`unsupported-dsh-version:${actualDshVersion}`)
    const disk = await statfs(home)
    const free = Number(disk.bavail) * Number(disk.bsize)
    if (free < (options.minimumFreeBytes ?? 128 * 1024 * 1024)) throw new Error('insufficient-disk-space')
    failPoint('preflight'); pass('preflight', `backup=${plan.backupId}; platform=${actualPlatform}; dsh=${actualDshVersion}`)

    await rm(stageDir, { recursive: true, force: true })
    await copyProfileControl(sourceBackupDir, stageDir)
    const stagedInstall = await run(['plugin', '--profile', stageProfile, 'install', '--ignore-scripts', '--reporter=silent'], { ...process.env, DSH_HOME: home })
    if (stagedInstall.code !== 0) throw new Error(`rollback-stage-install-failed:${stagedInstall.code ?? 'spawn'}`)
    await atomicJson(journalPath, journalFor(plan, 'staged', options.now?.() ?? new Date()))
    failPoint('staging'); pass('staging', `profile=${stageProfile}`)

    const stagedDump = await run(['--profile', stageProfile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (stagedDump.code !== 0) throw new Error(`staged-dump-config-failed:${stagedDump.code ?? 'spawn'}`)
    failPoint('dump-config'); pass('dump-config')

    await rm(join(stageDir, 'node_modules'), { recursive: true, force: true })
    await mkdir(dirname(undoBackupDir), { recursive: true })
    await rename(profileDir, undoBackupDir)
    await atomicJson(journalPath, journalFor(plan, 'original-moved', options.now?.() ?? new Date()))
    try { await rename(stageDir, profileDir) } catch (error) {
      await rename(undoBackupDir, profileDir)
      throw error
    }
    committed = true
    await atomicJson(journalPath, journalFor(plan, 'committed', options.now?.() ?? new Date()))
    failPoint('commit'); pass('commit', `undo-backup=${plan.id}`)

    const relink = await run(['plugin', '--profile', plan.profile, 'install', '--ignore-scripts', '--reporter=silent'], { ...process.env, DSH_HOME: home })
    if (relink.code !== 0) throw new Error(`final-profile-relink-failed:${relink.code ?? 'spawn'}`)
    failPoint('relink'); pass('relink', 'official plugin install rebuilt final-path dependencies')

    const health = await run(['--profile', plan.profile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (health.code !== 0) throw new Error(`restored-profile-health-failed:${health.code ?? 'spawn'}`)
    failPoint('health'); pass('health', 'official dump-config passed')
    failPoint('complete'); pass('complete')
    await atomicJson(journalPath, journalFor(plan, 'complete', options.now?.() ?? new Date()))
    return { ok: true, planId: plan.id, action: plan.action, profile: plan.profile, phases, backupId: plan.id, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failedPhase = plan.phases.find(phase => !phases.some(result => result.phase === phase)) ?? 'preflight'
    phases.push({ phase: failedPhase, status: 'failed', detail: message })
    if (committed) {
      try {
        await mkdir(dirname(failedDir), { recursive: true })
        await rm(failedDir, { recursive: true, force: true })
        await rename(profileDir, failedDir)
        await rename(undoBackupDir, profileDir)
        phases.push({ phase: 'rollback', status: 'passed', detail: `rollback-operation-restored=${plan.id}` })
      } catch (rollbackError) {
        phases.push({ phase: 'rollback', status: 'failed', detail: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) })
      }
    } else {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {})
      phases.push({ phase: 'rollback', status: 'passed', detail: 'current-profile-untouched' })
    }
    await atomicJson(journalPath, journalFor(plan, 'rolled-back', options.now?.() ?? new Date())).catch(() => {})
    return { ok: false, planId: plan.id, action: plan.action, profile: plan.profile, phases, error: message, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } finally {
    if (locked) await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

type FlowJournalStatus = 'started' | 'staged' | 'committed' | 'complete' | 'rolled-back' | 'recovered'
interface FlowTransactionJournal {
  schemaVersion: 1
  planId: string
  profile: string
  pid: number
  status: FlowJournalStatus
  updatedAt: string
}

const FLOW_TEMPLATE_BUNDLES = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
} as const

async function applyFlowProfileTemplate(profileDir: string, template: FlowInstallPlan['profile']['template']): Promise<void> {
  const manifestPath = join(profileDir, 'package.json')
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const dsh = parsed.dsh !== null && typeof parsed.dsh === 'object' && !Array.isArray(parsed.dsh) ? parsed.dsh as Record<string, unknown> : {}
  const profile = dsh.profile !== null && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile) ? dsh.profile as Record<string, unknown> : {}
  await atomicJson(manifestPath, { ...parsed, dsh: { ...dsh, profile: { ...profile, bundles: [...FLOW_TEMPLATE_BUNDLES[template]] } } })
}

function flowJournal(plan: FlowInstallPlan, status: FlowJournalStatus, now: Date): FlowTransactionJournal {
  return { schemaVersion: 1, planId: plan.id, profile: plan.profile.name, pid: process.pid, status, updatedAt: now.toISOString() }
}

function validateExecutableFlowPlan(plan: FlowInstallPlan, actualPlatform: string, actualDshVersion: string, availableCredentials: Set<string>): void {
  safeProfile(plan.profile.name)
  if (plan.profile.isolation !== 'new') throw new Error('flow-profile-must-be-new')
  if (!plan.executable || plan.blockers.length > 0) throw new Error('flow-plan-not-executable')
  if (plan.risk.registrySignature !== 'verified') throw new Error('registry-signature-unverified')
  if (plan.stack.platform.os !== actualPlatform) throw new Error(`unsupported-platform:${actualPlatform}`)
  if (plan.stack.dshVersion !== actualDshVersion) throw new Error(`flow-plan-dsh-version-mismatch:${actualDshVersion}`)
  const missingCredentials = plan.risk.credentials.filter(name => !availableCredentials.has(name))
  if (missingCredentials.length > 0) throw new Error(`missing-credentials:${missingCredentials.join(',')}`)
  if (plan.operations.length === 0) throw new Error('flow-plan-has-no-operations')
  for (const [index, operation] of plan.operations.entries()) {
    if (operation.order !== index + 1 || operation.action !== 'add') throw new Error('flow-operation-order-invalid')
    if (operation.verification !== 'passed') throw new Error(`plugin-not-verified:${operation.package}:${operation.verification}`)
    const kind = inferSourceKind(operation.source.spec)
    if (kind !== operation.source.kind) throw new Error(`flow-source-kind-mismatch:${operation.package}`)
    const locked = plan.stack.packages.find(item => item.package === operation.package && item.version === operation.version)
    if (locked === undefined || locked.source !== operation.source.spec || locked.integrity !== operation.source.integrity) throw new Error(`flow-stack-operation-mismatch:${operation.package}`)
  }
}

/** Execute all Flow package additions in one staging Profile and commit once. */
export async function executeFlowInstallPlan(plan: FlowInstallPlan, options: FlowTransactionOptions): Promise<FlowTransactionResult> {
  const startedAt = (options.now?.() ?? new Date()).toISOString()
  const steps: FlowTransactionResult['steps'] = []
  const home = dshHome(options.home)
  const profilesRoot = join(home, 'profiles')
  const stateRoot = join(home, 'flow-hub')
  const profileName = plan.profile.name
  const profileDir = join(profilesRoot, profileName)
  const stageProfile = `flow-hub-stage-${plan.id}`
  const stageDir = join(profilesRoot, stageProfile)
  const snapshotDir = join(stateRoot, 'flow-snapshots', plan.id)
  const failedDir = join(stateRoot, 'failed', plan.id)
  const lockDir = join(stateRoot, 'locks', `${profileName}.lock`)
  const journalPath = join(stateRoot, 'flow-transactions', `${plan.id}.json`)
  const stackLockPath = join(profileDir, `${plan.flow.id}.stack.lock.json`)
  const run = options.run ?? ((args, env) => defaultRun(options.dshCli, args, env))
  let locked = false
  let committed = false
  const pass = (step: FlowInstallPlan['steps'][number], detail?: string): void => { steps.push({ step, status: 'passed', ...(detail ? { detail } : {}) }) }
  const failPoint = (step: FlowInstallPlan['steps'][number]): void => { if (options.failAt === step) throw new Error(`injected-failure:${step}`) }
  try {
    const actualPlatform = options.runtimePlatform ?? platform()
    const actualDshVersion = options.dshVersion ?? detectedDshVersion()
    if (actualDshVersion === null) throw new Error('dsh-version-unknown')
    const availableCredentials = new Set(options.availableCredentials ?? Object.keys(process.env).filter(name => Boolean(process.env[name])))
    validateExecutableFlowPlan(plan, actualPlatform, actualDshVersion, availableCredentials)
    for (const target of [profileDir, stageDir, snapshotDir, failedDir, lockDir, journalPath, stackLockPath]) {
      if (!inside(home, target)) throw new Error('transaction-path-outside-dsh-home')
    }
    if (await exists(profileDir)) throw new Error('flow-target-profile-already-exists')
    const disk = await statfs(home)
    const free = Number(disk.bavail) * Number(disk.bsize)
    if (free < (options.minimumFreeBytes ?? 128 * 1024 * 1024)) throw new Error('insufficient-disk-space')
    const networkKinds = new Set(plan.operations.map(item => item.source.kind).filter(kind => kind === 'npm' || kind === 'github-sha'))
    for (const kind of networkKinds) {
      const endpoint = kind === 'npm' ? 'https://registry.npmjs.org/' : 'https://github.com/'
      if (!await (options.networkProbe ?? defaultNetworkProbe)(endpoint)) throw new Error(`network-preflight-failed:${kind}`)
    }
    await mkdir(dirname(lockDir), { recursive: true })
    try { await mkdir(lockDir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('profile-transaction-locked')
      throw error
    }
    locked = true
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ planId: plan.id, startedAt }) + '\n', 'utf8')
    await atomicJson(journalPath, flowJournal(plan, 'started', options.now?.() ?? new Date()))
    failPoint('preflight'); pass('preflight', `platform=${actualPlatform}; dsh=${actualDshVersion}; signature=verified; scripts=disabled`)

    await rm(stageDir, { recursive: true, force: true })
    const initialized = await run(['plugin', '--profile', stageProfile, 'install', '--ignore-scripts', '--reporter=silent'], { ...process.env, DSH_HOME: home })
    if (initialized.code !== 0) throw new Error(`flow-profile-initialize-failed:${initialized.code ?? 'spawn'}`)
    await applyFlowProfileTemplate(stageDir, plan.profile.template)
    failPoint('initialize-profile'); pass('initialize-profile', `template=${plan.profile.template}`)

    await mkdir(snapshotDir, { recursive: true })
    await atomicJson(join(snapshotDir, 'original.json'), { profile: profileName, existed: false })
    await atomicJson(join(snapshotDir, 'plan.json'), plan)
    failPoint('snapshot'); pass('snapshot', 'original-profile=absent')

    await atomicJson(journalPath, flowJournal(plan, 'staged', options.now?.() ?? new Date()))
    failPoint('staging'); pass('staging', `profile=${stageProfile}`)

    for (const operation of plan.operations) {
      const installed = await run(['plugin', '--profile', stageProfile, 'add', operation.source.spec, '--save-exact', '--ignore-scripts', '--reporter=silent'], { ...process.env, DSH_HOME: home })
      if (installed.code !== 0) throw new Error(`flow-package-install-failed:${operation.package}:${installed.code ?? 'spawn'}`)
    }
    failPoint('install-packages'); pass('install-packages', `packages=${plan.operations.length}`)

    const stagedDump = await run(['--profile', stageProfile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (stagedDump.code !== 0) throw new Error(`flow-staged-dump-config-failed:${stagedDump.code ?? 'spawn'}`)
    failPoint('dump-config'); pass('dump-config')

    const smoke = await options.bootSmoke(stageProfile, { ...process.env, DSH_HOME: home })
    if (smoke.code !== 0) throw new Error(`flow-boot-smoke-failed:${smoke.code ?? 'spawn'}`)
    failPoint('boot-smoke'); pass('boot-smoke')

    await rm(join(stageDir, 'node_modules'), { recursive: true, force: true })
    await mkdir(profilesRoot, { recursive: true })
    await rename(stageDir, profileDir)
    committed = true
    await atomicJson(journalPath, flowJournal(plan, 'committed', options.now?.() ?? new Date()))
    failPoint('commit'); pass('commit', 'new-profile-committed')

    const relink = await run(['plugin', '--profile', profileName, 'install', '--ignore-scripts', '--reporter=silent'], { ...process.env, DSH_HOME: home })
    if (relink.code !== 0) throw new Error(`flow-final-profile-relink-failed:${relink.code ?? 'spawn'}`)
    const health = await run(['--profile', profileName, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (health.code !== 0) throw new Error(`flow-committed-profile-health-failed:${health.code ?? 'spawn'}`)
    const finalSmoke = await options.bootSmoke(profileName, { ...process.env, DSH_HOME: home })
    if (finalSmoke.code !== 0) throw new Error(`flow-committed-profile-boot-failed:${finalSmoke.code ?? 'spawn'}`)
    failPoint('health'); pass('health', 'dump-config-and-boot-smoke-passed')

    await atomicJson(stackLockPath, plan.stack satisfies StackLock)
    failPoint('write-stack-lock'); pass('write-stack-lock', `${plan.flow.id}.stack.lock.json`)
    await atomicJson(journalPath, flowJournal(plan, 'complete', options.now?.() ?? new Date()))
    return { ok: true, planId: plan.id, action: 'install-flow', profile: profileName, steps, stackLockPath, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failedStep = plan.steps.find(step => !steps.some(result => result.step === step)) ?? 'preflight'
    steps.push({ step: failedStep, status: 'failed', detail: message })
    if (committed && await exists(profileDir)) {
      try {
        await mkdir(dirname(failedDir), { recursive: true })
        await rm(failedDir, { recursive: true, force: true })
        await rename(profileDir, failedDir)
        steps.push({ step: 'rollback', status: 'passed', detail: 'original-profile=absent' })
      } catch (rollbackError) {
        steps.push({ step: 'rollback', status: 'failed', detail: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) })
      }
    } else {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {})
      steps.push({ step: 'rollback', status: 'passed', detail: 'target-profile-not-created' })
    }
    await atomicJson(journalPath, flowJournal(plan, 'rolled-back', options.now?.() ?? new Date())).catch(() => {})
    return { ok: false, planId: plan.id, action: 'install-flow', profile: profileName, steps, error: message, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } finally {
    if (locked) await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Remove a partially committed new Flow Profile after an interrupted process. */
export async function recoverInterruptedFlowTransactions(options: { home?: string, now?: () => Date, isProcessAlive?: (pid: number) => boolean } = {}): Promise<FlowTransactionResult[]> {
  const home = dshHome(options.home)
  const root = join(home, 'flow-hub', 'flow-transactions')
  let names: string[]
  try { names = await readdir(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const results: FlowTransactionResult[] = []
  for (const name of names.filter(value => /^[a-f0-9]{24}\.json$/.test(value))) {
    let journal: FlowTransactionJournal
    try { journal = JSON.parse(await readFile(join(root, name), 'utf8')) as FlowTransactionJournal } catch { continue }
    if (journal.schemaVersion !== 1 || `${journal.planId}.json` !== name || ['complete', 'rolled-back', 'recovered'].includes(journal.status)) continue
    if ((options.isProcessAlive ?? processAlive)(journal.pid)) continue
    try { safeProfile(journal.profile) } catch { continue }
    const profileDir = join(home, 'profiles', journal.profile)
    const stageDir = join(home, 'profiles', `flow-hub-stage-${journal.planId}`)
    const failedDir = join(home, 'flow-hub', 'failed', journal.planId)
    const lockDir = join(home, 'flow-hub', 'locks', `${journal.profile}.lock`)
    if (![profileDir, stageDir, failedDir, lockDir].every(target => inside(home, target))) continue
    const steps: FlowTransactionResult['steps'] = []
    try {
      // A hard stop can occur after the atomic stage->target rename but before
      // the journal advances from staged to committed. Flow targets are new
      // by contract, so any target found for an unfinished journal is partial.
      if (await exists(profileDir)) {
        await mkdir(dirname(failedDir), { recursive: true })
        await rm(failedDir, { recursive: true, force: true })
        await rename(profileDir, failedDir)
      }
      await rm(stageDir, { recursive: true, force: true })
      await rm(lockDir, { recursive: true, force: true })
      await atomicJson(join(root, name), { ...journal, status: 'recovered', updatedAt: (options.now?.() ?? new Date()).toISOString() })
      steps.push({ step: 'rollback', status: 'passed', detail: 'interrupted-new-profile-removed' })
      results.push({ ok: false, planId: journal.planId, action: 'install-flow', profile: journal.profile, steps, error: 'interrupted-flow-transaction-recovered', startedAt: journal.updatedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() })
    } catch (error) {
      steps.push({ step: 'rollback', status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      results.push({ ok: false, planId: journal.planId, action: 'install-flow', profile: journal.profile, steps, error: 'interrupted-flow-transaction-recovery-failed', startedAt: journal.updatedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() })
    }
  }
  return results
}
