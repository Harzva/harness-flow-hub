import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type PluginAction = 'add' | 'update' | 'remove'
export type SourceKind = 'npm' | 'tgz' | 'github-sha' | 'local-directory'
export type TransactionPhase = 'preflight' | 'snapshot' | 'staging' | 'install' | 'dump-config' | 'commit' | 'health' | 'rollback' | 'complete'

export interface InstallPlan {
  schemaVersion: 1
  id: string
  createdAt: string
  expiresAt: string
  action: PluginAction
  profile: string
  packageName: string
  source: { kind: SourceKind, spec: string }
  risk: { lifecycleScriptsDisabled: true, permissions: string[], credentials: string[], verification: string }
  phases: TransactionPhase[]
}

export interface PhaseResult { phase: TransactionPhase, status: 'passed' | 'failed' | 'skipped', detail?: string }
export interface TransactionResult {
  ok: boolean
  planId: string
  action: PluginAction
  profile: string
  phases: PhaseResult[]
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
  permissions?: string[], credentials?: string[], verification?: string, now?: Date,
}): InstallPlan {
  safeProfile(input.profile)
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(input.packageName)) throw new Error('invalid-package-name')
  const source = { kind: inferSourceKind(input.sourceSpec), spec: input.sourceSpec }
  const now = input.now ?? new Date()
  const body = {
    schemaVersion: 1 as const,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    action: input.action,
    profile: input.profile,
    packageName: input.packageName,
    source,
    risk: {
      lifecycleScriptsDisabled: true as const,
      permissions: [...(input.permissions ?? [])],
      credentials: [...(input.credentials ?? [])],
      verification: input.verification ?? 'unverified',
    },
    phases: ['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'health', 'complete'] as TransactionPhase[],
  }
  const id = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)
  return { ...body, id }
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
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
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
  const run = options.run ?? ((args, env) => defaultRun(options.dshCli, args, env))
  let locked = false
  let committed = false
  const pass = (phase: TransactionPhase, detail?: string): void => { phases.push({ phase, status: 'passed', ...(detail ? { detail } : {}) }) }
  const failPoint = (phase: TransactionPhase): void => { if (options.failAt === phase) throw new Error(`injected-failure:${phase}`) }
  try {
    safeProfile(plan.profile)
    if (Date.parse(plan.expiresAt) <= Date.parse(startedAt)) throw new Error('install-plan-expired')
    for (const target of [profileDir, stageDir, snapshotDir, backupDir, lockDir, failedDir]) {
      if (!inside(home, target)) throw new Error('transaction-path-outside-dsh-home')
    }
    await mkdir(dirname(lockDir), { recursive: true })
    try { await mkdir(lockDir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('profile-transaction-locked')
      throw error
    }
    locked = true
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ planId: plan.id, startedAt }) + '\n', 'utf8')
    if (!(await stat(join(profileDir, 'package.json'))).isFile()) throw new Error('profile-not-initialized')
    const disk = await statfs(home)
    const free = Number(disk.bavail) * Number(disk.bsize)
    if (free < (options.minimumFreeBytes ?? 128 * 1024 * 1024)) throw new Error('insufficient-disk-space')
    failPoint('preflight'); pass('preflight', `source=${plan.source.kind}; scripts=disabled`)

    await copyProfileControl(profileDir, snapshotDir)
    await writeFile(join(snapshotDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8')
    failPoint('snapshot'); pass('snapshot', `snapshot=${plan.id}`)

    await rm(stageDir, { recursive: true, force: true })
    await copyProfileControl(profileDir, stageDir)
    failPoint('staging'); pass('staging', `profile=${stageProfile}`)

    const install = await run(commandFor(plan, stageProfile), { ...process.env, DSH_HOME: home })
    if (install.code !== 0) throw new Error(`plugin-command-failed:${install.code ?? 'spawn'}`)
    failPoint('install'); pass('install')

    const stagedDump = await run(['--profile', stageProfile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (stagedDump.code !== 0) throw new Error(`staged-dump-config-failed:${stagedDump.code ?? 'spawn'}`)
    failPoint('dump-config'); pass('dump-config')

    await mkdir(dirname(backupDir), { recursive: true })
    await rename(profileDir, backupDir)
    try { await rename(stageDir, profileDir) } catch (error) {
      await rename(backupDir, profileDir)
      throw error
    }
    committed = true
    failPoint('commit'); pass('commit', `backup=${plan.id}`)

    const health = await run(['--profile', plan.profile, '--dump-config'], { ...process.env, DSH_HOME: home })
    if (health.code !== 0) throw new Error(`committed-profile-health-failed:${health.code ?? 'spawn'}`)
    failPoint('health'); pass('health', 'official dump-config passed')
    pass('complete')
    return { ok: true, planId: plan.id, action: plan.action, profile: plan.profile, phases, backupId: plan.id, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
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
    return { ok: false, planId: plan.id, action: plan.action, profile: plan.profile, phases, error: message, startedAt, finishedAt: (options.now?.() ?? new Date()).toISOString() }
  } finally {
    if (locked) await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}
