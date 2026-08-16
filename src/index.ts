import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const inject = ['webServer']

export interface Config {
  profile?: string
  fixtureSpec?: string
}

type BootstrapState = 'compatible' | 'unknown' | 'incompatible'
type PluginAction = 'add' | 'update' | 'remove'

interface CommandResult {
  ok: boolean
  action: PluginAction
  code: number | null
  command: string[]
  stdout: string
  stderr: string
  startedAt: string
  finishedAt: string
}

type TaskRecord = Pick<CommandResult, 'ok' | 'action' | 'code' | 'startedAt' | 'finishedAt'>

const PACKAGE_NAME = '@harness-flow/hello-bundle'
const API_PATH = '/flow-hub/api'
const MAX_BODY_BYTES = 16 * 1024
let activeTransaction = false
const recentTransactions: TaskRecord[] = []

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

export function classifyVersion(version: string | null): BootstrapState {
  if (version === null) return 'unknown'
  const match = /^0\.1\.(\d+)(?:-rc\.(\d+))?$/.exec(version)
  if (match === null) return 'incompatible'
  const patch = Number(match[1])
  const releaseCandidate = match[2] === undefined ? null : Number(match[2])
  if (patch > 0 || releaseCandidate === null || releaseCandidate >= 6) return 'compatible'
  return 'incompatible'
}

function commandFor(action: PluginAction, profile: string, fixtureSpec: string): string[] {
  const base = ['plugin', '--profile', profile]
  if (action === 'add') return [...base, 'add', fixtureSpec, '--save-exact', '--reporter=append-only']
  if (action === 'update') return [...base, 'update', PACKAGE_NAME, '--latest', '--reporter=append-only']
  return [...base, 'remove', PACKAGE_NAME, '--reporter=append-only']
}

async function runDsh(action: PluginAction, profile: string, fixtureSpec: string): Promise<CommandResult> {
  const args = commandFor(action, profile, fixtureSpec)
  const cli = resolveDshCli()
  const command = process.execPath
  const startedAt = new Date().toISOString()
  return await new Promise((resolve) => {
    const child = spawn(command, [cli, ...args], { shell: false, windowsHide: true, env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += String(chunk) })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      resolve({
        ok: false,
        action,
        code: null,
        command: ['dsh', ...args],
        stdout,
        stderr: `${stderr}${error.message}`,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
    })
    child.on('close', code => {
      resolve({
        ok: code === 0,
        action,
        code,
        command: ['dsh', ...args],
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
    })
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const profile = config.profile?.trim() || 'web'
  const fixtureSpec = config.fixtureSpec?.trim() || ''
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
    if (pathname === `${API_PATH}/profiles` && req.method === 'GET') {
      json(res, 200, { ok: true, profiles: [{ id: profile, active: true, managedBy: 'dsh' }] })
      return
    }
    if (pathname === `${API_PATH}/tasks` && req.method === 'GET') {
      json(res, 200, { ok: true, active: activeTransaction, tasks: recentTransactions })
      return
    }
    if (pathname !== `${API_PATH}/plugin` || req.method !== 'POST') {
      json(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (!isLoopback(req) || !sameOrigin(req)) {
      json(res, 403, { ok: false, error: 'local-same-origin-required' })
      return
    }
    if (fixtureSpec.length === 0) {
      json(res, 409, { ok: false, error: 'fixture-not-configured' })
      return
    }
    if (activeTransaction) {
      json(res, 409, { ok: false, error: 'transaction-in-progress' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid-request' })
      return
    }
    const action = body.action
    if (action !== 'add' && action !== 'update' && action !== 'remove') {
      json(res, 400, { ok: false, error: 'unsupported-action' })
      return
    }
    activeTransaction = true
    try {
      const result = await runDsh(action, profile, fixtureSpec)
      recentTransactions.unshift({
        ok: result.ok,
        action: result.action,
        code: result.code,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })
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
