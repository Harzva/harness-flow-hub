import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parse as parseYaml } from 'yaml'
import { compareFlowVariants, compileFlowInstallPlan, compileStackPreview, type FlowVariantName, type HarnessFlow, type RegistryPlugin } from './flow-resolver.js'
import {
  createInstallPlan, createRollbackPlan, executeInstallPlan, executeRollbackPlan, listRecoveryPoints, recoverInterruptedTransactions,
  type InstallPlan, type PluginAction, type RollbackPlan, type TransactionPhase, type TransactionResult,
} from './transaction.js'

export const inject = ['webServer']

export interface Config {
  profile?: string
  fixtureSpec?: string
  dshHome?: string
  testFailAt?: string
}

type BootstrapState = 'compatible' | 'unknown' | 'incompatible'
type TaskRecord = TransactionResult

const PACKAGE_NAME = '@harness-flow/hello-bundle'
const API_PATH = '/flow-hub/api'
const MAX_BODY_BYTES = 16 * 1024
let activeTransaction = false
const recentTransactions: TaskRecord[] = []
const pendingPlans = new Map<string, InstallPlan>()
const pendingRollbackPlans = new Map<string, RollbackPlan>()
const TEST_FAILURE_PHASES = new Set<TransactionPhase>(['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'relink', 'health', 'complete'])

export function parseTestFailurePhase(value?: string): TransactionPhase | undefined {
  const phase = value?.trim()
  if (phase === undefined || phase === '') return undefined
  if (!TEST_FAILURE_PHASES.has(phase as TransactionPhase)) throw new Error(`invalid-test-failure-phase:${phase}`)
  return phase as TransactionPhase
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined) return true
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-json-object')
  return value as Record<string, unknown>
}

function resolveDshVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const path = require.resolve('@deepseek-ai/dsh/package.json')
    const pkg = require(path) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

function resolveHubPackage(): { version: string | null, root: string | null } {
  try {
    const require = createRequire(import.meta.url)
    const packagePath = require.resolve('@harness-flow/dsh-flow-hub/package.json')
    const pkg = require(packagePath) as { version?: unknown }
    return { version: typeof pkg.version === 'string' ? pkg.version : null, root: dirname(packagePath) }
  } catch {
    return { version: null, root: null }
  }
}

function resolveRegistry(): unknown {
  const hub = resolveHubPackage()
  if (hub.root === null) throw new Error('hub-package-unavailable')
  return JSON.parse(readFileSync(resolve(hub.root, 'registry/generated/registry.json'), 'utf8')) as unknown
}

function resolveFlowCatalog(): unknown[] {
  const hub = resolveHubPackage()
  if (hub.root === null) throw new Error('hub-package-unavailable')
  const registry = resolveRegistry() as { generatedFrom: { asOf: string }, plugins: RegistryPlugin[] }
  const dshVersion = resolveDshVersion()
  if (dshVersion === null) throw new Error('dsh-version-unavailable')
  if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') throw new Error(`unsupported-platform:${process.platform}`)
  const platform = process.platform as 'win32' | 'linux' | 'darwin'
  const generatedAt = `${registry.generatedFrom.asOf}T00:00:00.000Z`
  const directory = resolve(hub.root, 'registry/flows')
  return readdirSync(directory).filter(name => name.endsWith('.dsh-flow.yml')).sort().map(name => {
    const flow = parseYaml(readFileSync(resolve(directory, name), 'utf8')) as HarnessFlow
    const names = Object.keys(flow.variants).sort() as FlowVariantName[]
    const variants = names.map(id => ({
      id,
      ...flow.variants[id],
      stack: compileStackPreview(flow, id, registry.plugins, {
        generatedAt,
        dshVersion,
        platform,
        arch: process.arch,
        node: process.version,
      }),
      installPlan: compileFlowInstallPlan(flow, id, registry.plugins, {
        generatedAt,
        dshVersion,
        platform,
        arch: process.arch,
        node: process.version,
        registrySignature: 'unverified',
      }),
    }))
    const comparisons = names.flatMap((from, index) => names.slice(index + 1).map(to => ({ from, to, diff: compareFlowVariants(flow, from, to) })))
    return {
      id: flow.id,
      name: flow.name,
      version: flow.version,
      category: flow.category,
      goal: flow.goal,
      targetUsers: flow.targetUsers,
      expectedOutputs: flow.expectedOutputs,
      validation: flow.validation,
      uninstall: flow.uninstall,
      variants,
      comparisons,
    }
  })
}

function resolveDshCli(): string {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
  const pkg = require(packagePath) as { bin?: unknown }
  if (typeof pkg.bin === 'string') return resolve(dirname(packagePath), pkg.bin)
  if (typeof pkg.bin === 'object' && pkg.bin !== null) {
    const candidate = (pkg.bin as Record<string, unknown>).dsh
    if (typeof candidate === 'string') return resolve(dirname(packagePath), candidate)
  }
  throw new Error('@deepseek-ai/dsh package does not expose a dsh binary')
}

function configuredDshHome(configured?: string): string {
  return resolve(configured ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
}

function publicDependencySource(source: string | null): string | null {
  if (source === null) return null
  if (source.startsWith('file:') || source.startsWith('link:') || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('/') || source.startsWith('.')) return 'configured-local-source'
  return source
}

async function profileView(home: string, profile: string): Promise<unknown> {
  const profileDir = join(home, 'profiles', profile)
  let source: string | null = null
  let version: string | null = null
  let enabled = false
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>, dsh?: { profile?: { bundles?: unknown[] } },
    }
    const dependency = manifest.dependencies?.[PACKAGE_NAME]
    source = typeof dependency === 'string' ? dependency : null
    enabled = manifest.dsh?.profile?.bundles?.includes(PACKAGE_NAME) ?? false
    if (source !== null) {
      try {
        const installed = JSON.parse(readFileSync(join(profileDir, 'node_modules', '@harness-flow', 'hello-bundle', 'package.json'), 'utf8')) as { version?: unknown }
        version = typeof installed.version === 'string' ? installed.version : null
      } catch {}
    }
  } catch {}
  const recoveryPoints = await listRecoveryPoints({ home, profile })
  return { id: profile, active: true, managedBy: 'dsh', plugin: { packageName: PACKAGE_NAME, installed: source !== null, enabled, source: publicDependencySource(source), version }, recoveryPoints }
}

export function classifyVersion(version: string | null): BootstrapState {
  if (version === null) return 'unknown'
  const match = /^0\.1\.(\d+)(?:-rc\.(\d+))?$/.exec(version)
  if (match === null) return 'incompatible'
  const patch = Number(match[1])
  const releaseCandidate = match[2] === undefined ? null : Number(match[2])
  if (patch > 0 || releaseCandidate === null || releaseCandidate >= 6) return 'compatible'
  return 'incompatible'
}

function publicPlan(plan: InstallPlan): InstallPlan {
  if (plan.source.kind === 'npm' || plan.source.kind === 'github-sha') return plan
  return { ...plan, source: { ...plan.source, spec: `configured-${plan.source.kind}` } }
}

export function apply(ctx: Context, config: Config = {}): void {
  const profile = config.profile?.trim() || 'web'
  const fixtureSpec = config.fixtureSpec?.trim() || ''
  const home = configuredDshHome(config.dshHome)
  const testFailurePhase = parseTestFailurePhase(config.testFailAt)
  if (testFailurePhase !== undefined && fixtureSpec.length === 0) throw new Error('test-failure-injection-requires-fixture')
  const recoveryPromise = recoverInterruptedTransactions({ home: config.dshHome }).then(recovered => {
    recentTransactions.unshift(...recovered)
    if (recentTransactions.length > 20) recentTransactions.length = 20
  }).catch(() => {})
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://local').pathname
    if (pathname === `${API_PATH}/bootstrap` && req.method === 'GET') {
      const dshVersion = resolveDshVersion()
      const hub = resolveHubPackage()
      json(res, 200, {
        ok: true,
        state: classifyVersion(dshVersion),
        dshVersion,
        supported: '>=0.1.0-rc.6 <0.2.0 (M0 verified prereleases)',
        profile,
        fixtureReady: fixtureSpec.length > 0,
        packageName: PACKAGE_NAME,
        hubVersion: hub.version,
        testFailurePhase: testFailurePhase ?? null,
      })
      return
    }
    if (pathname === `${API_PATH}/registry` && req.method === 'GET') {
      try {
        json(res, 200, { ok: true, registry: resolveRegistry() })
      } catch (error) {
        json(res, 503, { ok: false, error: error instanceof Error ? error.message : 'registry-unavailable' })
      }
      return
    }
    if (pathname === `${API_PATH}/flows` && req.method === 'GET') {
      try {
        json(res, 200, { ok: true, flows: resolveFlowCatalog() })
      } catch (error) {
        json(res, 503, { ok: false, error: error instanceof Error ? error.message : 'flow-catalog-unavailable' })
      }
      return
    }
    if (pathname === `${API_PATH}/profiles` && req.method === 'GET') {
      await recoveryPromise
      json(res, 200, { ok: true, profiles: [await profileView(home, profile)] })
      return
    }
    if (pathname === `${API_PATH}/tasks` && req.method === 'GET') {
      await recoveryPromise
      json(res, 200, { ok: true, active: activeTransaction, tasks: recentTransactions })
      return
    }
    const writePaths = [`${API_PATH}/plan`, `${API_PATH}/plugin`, `${API_PATH}/rollback-plan`, `${API_PATH}/rollback`]
    if (!writePaths.includes(pathname) || req.method !== 'POST') {
      json(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (!isLoopback(req) || !sameOrigin(req)) {
      json(res, 403, { ok: false, error: 'local-same-origin-required' })
      return
    }
    if ((pathname === `${API_PATH}/plan` || pathname === `${API_PATH}/plugin`) && fixtureSpec.length === 0) {
      json(res, 409, { ok: false, error: 'fixture-not-configured' })
      return
    }
    if (activeTransaction && (pathname === `${API_PATH}/plugin` || pathname === `${API_PATH}/rollback`)) {
      json(res, 409, { ok: false, error: 'transaction-in-progress' })
      return
    }
    if (pathname === `${API_PATH}/plugin` || pathname === `${API_PATH}/rollback` || pathname === `${API_PATH}/rollback-plan`) await recoveryPromise
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-request' })
      return
    }
    if (pathname === `${API_PATH}/plan`) {
      const action = body.action
      if (action !== 'add' && action !== 'update' && action !== 'remove') {
        json(res, 400, { ok: false, error: 'unsupported-action' })
        return
      }
      try {
        const plan = createInstallPlan({
          action: action as PluginAction,
          profile,
          packageName: PACKAGE_NAME,
          sourceSpec: fixtureSpec,
          verification: 'trusted-fixture',
          signature: 'not-applicable-trusted-fixture',
        })
        pendingPlans.set(plan.id, plan)
        json(res, 200, { ok: true, plan: publicPlan(plan) })
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-install-plan' })
      }
      return
    }
    if (pathname === `${API_PATH}/rollback-plan`) {
      const backupId = body.backupId
      if (typeof backupId !== 'string' || !/^[a-f0-9]{24}$/.test(backupId)) {
        json(res, 400, { ok: false, error: 'invalid-backup-id' })
        return
      }
      const points = await listRecoveryPoints({ home, profile })
      if (!points.some(point => point.backupId === backupId)) {
        json(res, 409, { ok: false, error: 'recovery-point-unavailable' })
        return
      }
      const plan = createRollbackPlan({ profile, backupId })
      pendingRollbackPlans.set(plan.id, plan)
      json(res, 200, { ok: true, plan })
      return
    }
    const planId = body.planId
    if (typeof planId !== 'string' || !/^[a-f0-9]{24}$/.test(planId)) {
      json(res, 400, { ok: false, error: 'invalid-plan-id' })
      return
    }
    if (pathname === `${API_PATH}/rollback`) {
      const rollbackPlan = pendingRollbackPlans.get(planId)
      if (rollbackPlan === undefined) {
        json(res, 409, { ok: false, error: 'rollback-plan-missing-or-consumed' })
        return
      }
      pendingRollbackPlans.delete(planId)
      activeTransaction = true
      try {
        const result = await executeRollbackPlan(rollbackPlan, { dshCli: resolveDshCli(), home, dshVersion: resolveDshVersion() ?? undefined, failAt: testFailurePhase })
        recentTransactions.unshift(result)
        if (recentTransactions.length > 20) recentTransactions.length = 20
        json(res, result.ok ? 200 : 502, result)
      } finally {
        activeTransaction = false
      }
      return
    }
    const plan = pendingPlans.get(planId)
    if (plan === undefined) {
      json(res, 409, { ok: false, error: 'install-plan-missing-or-consumed' })
      return
    }
    pendingPlans.delete(planId)
    activeTransaction = true
    try {
      const result = await executeInstallPlan(plan, { dshCli: resolveDshCli(), home, dshVersion: resolveDshVersion() ?? undefined, failAt: testFailurePhase })
      recentTransactions.unshift(result)
      if (recentTransactions.length > 20) recentTransactions.length = 20
      json(res, result.ok ? 200 : 502, result)
    } finally {
      activeTransaction = false
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PATH, handler }),
    'harness-flow-hub: local management API',
  )
}
