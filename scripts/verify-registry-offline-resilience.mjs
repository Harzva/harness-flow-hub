import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const hubArtifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
const fixtureArtifact = resolve(process.argv[3] ?? 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const output = resolve(process.argv[4] ?? 'evidence/m2-registry-offline-resilience-2026-08-17.json')
const tempRoot = resolve(process.env.DSH_REGISTRY_OFFLINE_TEMP_ROOT ?? '../../work/registry-offline-resilience')

function hash(value) { return createHash('sha256').update(value).digest('hex') }
function requireDsh(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`)
  return result
}
async function freePort() {
  const server = createServer()
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise(resolveClosed => server.close(resolveClosed))
  return port
}
async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 10_000)),
  ])
  if (stopped === 'timeout') child.kill('SIGKILL')
}
async function request(origin, path, body) {
  const response = await fetch(`${origin}/flow-hub/api/${path}`, body === undefined ? {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
  } : {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  return { status: response.status, payload: await response.json() }
}
async function startWeb(cli, home) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_FLOW_HUB_FIXTURE: fixtureArtifact,
      DSH_FLOW_HUB_REGISTRY_URL: 'https://127.0.0.1:9/registry.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited before bootstrap: ${child.exitCode}; ${stderr}`)
    try {
      const bootstrap = await request(origin, 'bootstrap')
      if (bootstrap.status === 200) return { child, origin, bootstrap }
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  await stop(child)
  throw new Error(`dsh web bootstrap timed out; ${stderr}`)
}

await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const home = await mkdtemp(join(tempRoot, 'run-'))
const cli = dshCliPath()
let server

try {
  requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-default-config']), 'profile bootstrap')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', hubArtifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'Hub install')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', fixtureArtifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'fixture install')

  server = await startWeb(cli, home)
  if (server.bootstrap.payload.state !== 'compatible') throw new Error('offline Registry changed Bootstrap compatibility')
  const registry = await request(server.origin, 'registry')
  if (registry.status !== 200 || registry.payload.availability?.upstream !== 'unreachable' || registry.payload.availability?.offlineReady !== true) throw new Error('Registry did not enter bundled offline fallback')
  if (!Array.isArray(registry.payload.registry?.plugins) || registry.payload.registry.plugins.length === 0) throw new Error('bundled Registry snapshot unavailable')
  const profiles = await request(server.origin, 'profiles')
  if (profiles.status !== 200 || profiles.payload.profiles?.[0]?.plugin?.installed !== true) throw new Error('installed Profile unavailable while Registry offline')
  const tasks = await request(server.origin, 'tasks')
  if (tasks.status !== 200 || !Array.isArray(tasks.payload.tasks)) throw new Error('local tasks unavailable while Registry offline')
  const flows = await request(server.origin, 'flows')
  if (flows.status !== 200 || !Array.isArray(flows.payload.flows)) throw new Error('bundled Flow catalog unavailable while Registry offline')
  const plan = await request(server.origin, 'plan', { action: 'update' })
  if (plan.status !== 200 || plan.payload.plan?.action !== 'update') throw new Error('local update plan unavailable while Registry offline')
  const update = await request(server.origin, 'plugin', { planId: plan.payload.plan.id })
  if (update.status !== 200 || update.payload.ok !== true) throw new Error(`isolated local update failed while Registry offline: ${update.payload.error ?? update.status}`)
  const client = await fetch(`${server.origin}/plugins/@harness-flow/dsh-flow-hub/client.js`, { signal: AbortSignal.timeout(15_000) })
  const clientText = await client.text()
  const installedClient = await readFile(join(home, 'profiles', 'web', 'node_modules', '@harness-flow', 'dsh-flow-hub', 'lib', 'client.js'), 'utf8')
  if (!client.ok || !clientText.includes('@harness-flow/dsh-flow-hub')) throw new Error('DSH client module route missing')
  if (!installedClient.includes('registryAvailability?.upstream === "unreachable"') || !installedClient.includes('Promise.allSettled')) throw new Error('offline-aware client bundle missing')
  await stop(server.child)
  server = undefined

  const dump = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'offline post-update dump-config')
  if (!dump.stdout.includes('harness-flow-hub') || !dump.stdout.includes('harness-flow-hello')) throw new Error('installed Profile failed offline dump-config')
  const report = {
    date: new Date().toISOString(),
    subject: 'Installed DSH Profile and local management remain available while configured upstream Registry is unreachable',
    environment: { os: process.platform, arch: process.arch, node: process.version, dsh: server?.bootstrap?.payload?.dshVersion ?? '0.1.0-rc.6', profile: 'isolated web' },
    commands: ['pnpm run ui:verify-registry-offline', 'dsh plugin --profile web add <trusted-tgz>', 'dsh --profile web --dump-config'],
    artifacts: {
      hub: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz', sha256: hash(await readFile(hubArtifact)) },
      fixture: { file: 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz', sha256: hash(await readFile(fixtureArtifact)) },
    },
    checks: {
      bootstrap: { status: 'passed', compatibility: 'compatible' },
      upstreamRegistry: { status: 'unreachable', addressRecorded: false },
      bundledRegistryFallback: { status: 'passed', offlineReady: true, pluginCount: registry.payload.registry.plugins.length },
      installedProfileInventory: { status: 'passed', installed: true },
      localTasks: { status: 'passed', http: tasks.status },
      bundledFlows: { status: 'passed', count: flows.payload.flows.length },
      localUpdate: { status: 'passed', http: update.status, phases: update.payload.phases?.map(item => item.phase) },
      clientModule: { status: 'passed', independentReads: true },
      dumpConfig: { status: 'passed', exitCode: dump.status },
    },
    privacy: { userProfileTouched: false, credentialsCaptured: false, privatePathsRecorded: false, registryAddressRecorded: false },
    result: 'passed',
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, checks: Object.keys(report.checks).length })}\n`)
} finally {
  if (server !== undefined) await stop(server.child)
  const resolvedHome = resolve(home)
  const guardedRoot = `${resolve(tempRoot)}${sep}`
  if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove offline Registry path outside temp root')
  await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
