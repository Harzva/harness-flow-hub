import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const hubArtifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
const fixtureArtifact = resolve(process.argv[3] ?? 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const output = resolve(process.argv[4] ?? 'evidence/m2-native-ui-lifecycle-2026-08-16.json')
const tempRoot = resolve(process.env.DSH_UI_LIFECYCLE_TEMP_ROOT ?? '../../work/native-ui-lifecycle')
const hubPackage = '@harness-flow/dsh-flow-hub'
const fixturePackage = '@harness-flow/hello-bundle'

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function freePort() {
  const server = createServer()
  await new Promise((ready, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', ready)
  })
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

async function startWeb(cli, home, fixtureSpec, failAt) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, DSH_HOME: home, DSH_FLOW_HUB_FIXTURE: fixtureSpec }
  if (failAt === undefined) delete env.DSH_FLOW_HUB_TEST_FAIL_AT
  else env.DSH_FLOW_HUB_TEST_FAIL_AT = failAt
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited before bootstrap: ${child.exitCode}; ${stderr}`)
    try {
      const response = await fetch(`${origin}/flow-hub/api/bootstrap`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return { child, origin }
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  await stop(child)
  throw new Error(`dsh web bootstrap timed out; ${stderr}`)
}

async function request(origin, path, body) {
  const response = await fetch(`${origin}/flow-hub/api/${path}`, body === undefined ? {
    cache: 'no-store', signal: AbortSignal.timeout(60_000),
  } : {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const payload = await response.json()
  return { status: response.status, payload }
}

async function readEventually(origin, path, child, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited while reading ${path}: ${child.exitCode}`)
    try {
      return await request(origin, path)
    } catch (error) {
      lastError = error
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
  throw lastError ?? new Error(`${path} did not recover`)
}

async function executePrepared(origin, path, planId, child) {
  try {
    return await request(origin, path, { planId })
  } catch (error) {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const tasks = await readEventually(origin, 'tasks', child).catch(() => null)
      const task = tasks?.payload?.tasks?.find(candidate => candidate.planId === planId)
      if (task !== undefined) return { status: task.ok ? 200 : 502, payload: task, recoveredAfterDisconnect: true }
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    throw error
  }
}

async function execute(origin, action, child) {
  const prepared = await request(origin, 'plan', { action })
  if (prepared.status !== 200 || prepared.payload.plan?.action !== action) throw new Error(`${action} plan failed`)
  const executed = await executePrepared(origin, 'plugin', prepared.payload.plan.id, child)
  return { plan: prepared.payload.plan, response: executed }
}

function requireDsh(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`)
  return result
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

  server = await startWeb(cli, home, fixtureArtifact)
  const bootstrap = await readEventually(server.origin, 'bootstrap', server.child)
  if (bootstrap.status !== 200 || bootstrap.payload.state !== 'compatible' || bootstrap.payload.testFailurePhase !== null) throw new Error('normal bootstrap contract failed')
  const flowCatalog = await readEventually(server.origin, 'flows', server.child)
  const catalogFlows = flowCatalog.payload.flows ?? []
  if (flowCatalog.status !== 200 || catalogFlows.length !== 3) throw new Error('native Flow catalog did not expose three definitions')
  if (new Set(catalogFlows.map(item => item.category)).size !== 3) throw new Error('native Flow catalog did not expose three category types')
  if (catalogFlows.some(item => item.variants?.length !== 4)) throw new Error('native Flow catalog did not expose four variants per Flow')
  if (catalogFlows.some(item => item.variants?.some(variant => variant.installPlan?.executable !== false))) throw new Error('unverified Flow dependency became executable in native UI')
  const initial = await readEventually(server.origin, 'profiles', server.child)
  if (initial.status !== 200 || initial.payload.profiles?.[0]?.plugin?.installed !== true) throw new Error('fixture is not installed before UI lifecycle')

  const update = await execute(server.origin, 'update', server.child)
  if (update.response.status !== 200 || update.response.payload.ok !== true) throw new Error(`UI update failed: ${update.response.payload.error ?? update.response.status}`)
  const remove = await execute(server.origin, 'remove', server.child)
  if (remove.response.status !== 200 || remove.response.payload.ok !== true || typeof remove.response.payload.backupId !== 'string') throw new Error(`UI remove failed: ${remove.response.payload.error ?? remove.response.status}`)
  const removed = await readEventually(server.origin, 'profiles', server.child)
  if (removed.payload.profiles?.[0]?.plugin?.installed !== false) throw new Error('UI remove did not update Host inventory')

  const rollbackPlan = await request(server.origin, 'rollback-plan', { backupId: remove.response.payload.backupId })
  if (rollbackPlan.status !== 200 || rollbackPlan.payload.plan?.action !== 'rollback') throw new Error('UI rollback plan failed')
  const rollback = await executePrepared(server.origin, 'rollback', rollbackPlan.payload.plan.id, server.child)
  if (rollback.status !== 200 || rollback.payload.ok !== true) throw new Error(`UI rollback failed: ${rollback.payload.error ?? rollback.status}`)
  const restored = await readEventually(server.origin, 'profiles', server.child)
  if (restored.payload.profiles?.[0]?.plugin?.installed !== true) throw new Error('UI rollback did not restore Host inventory')
  await stop(server.child)
  server = undefined

  const packagePath = join(home, 'profiles', 'web', 'package.json')
  const lockPath = join(home, 'profiles', 'web', 'pnpm-lock.yaml')
  const beforePackage = await readFile(packagePath)
  const beforeLock = await readFile(lockPath)

  server = await startWeb(cli, home, fixtureArtifact, 'health')
  const injectedBootstrap = await readEventually(server.origin, 'bootstrap', server.child)
  if (injectedBootstrap.payload.testFailurePhase !== 'health') throw new Error('failure-injection state is not visible in Bootstrap')
  const failedUpdate = await execute(server.origin, 'update', server.child)
  const rollbackPhase = failedUpdate.response.payload.phases?.find(item => item.phase === 'rollback')
  if (failedUpdate.response.status !== 502 || failedUpdate.response.payload.ok !== false || rollbackPhase?.status !== 'passed') throw new Error('injected UI failure did not report a passed rollback')
  await stop(server.child)
  server = undefined

  const afterPackage = await readFile(packagePath)
  const afterLock = await readFile(lockPath)
  if (hash(afterPackage) !== hash(beforePackage) || hash(afterLock) !== hash(beforeLock)) throw new Error('injected UI failure changed Profile control files')
  const healthyAfterFailure = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'post-failure dump-config')
  if (!healthyAfterFailure.stdout.includes('harness-flow-hello')) throw new Error('fixture missing after failed UI update recovery')

  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'remove', hubPackage, '--reporter=silent']), 'CLI rescue remove')
  const rescued = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'CLI rescue dump-config')
  if (rescued.stdout.includes('harness-flow-hub')) throw new Error('CLI rescue did not remove Hub')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', hubArtifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'CLI rescue reinstall')
  const recovered = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'CLI recovered dump-config')
  if (!recovered.stdout.includes('harness-flow-hub')) throw new Error('CLI rescue reinstall did not restore Hub')

  const baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  const report = {
    date: new Date().toISOString(),
    baseCommit,
    subject: 'DSH native Flow Hub lifecycle through same-origin Host API used by the client UI',
    environment: { os: process.platform, arch: process.arch, node: process.version, dsh: bootstrap.payload.dshVersion, profile: 'isolated web' },
    commands: [
      'pnpm run ui:verify-lifecycle',
      'dsh plugin --profile web add <signed-or-trusted-tgz>',
      'dsh --profile web --dump-config',
      'dsh plugin --profile web remove @harness-flow/dsh-flow-hub',
    ],
    artifacts: {
      hub: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz', sha256: hash(await readFile(hubArtifact)) },
      fixture: { file: 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz', sha256: hash(await readFile(fixtureArtifact)) },
    },
    checks: {
      bootstrap: { status: 'passed', state: bootstrap.payload.state },
      flowCatalog: { status: 'passed', flows: catalogFlows.map(item => item.id), categories: catalogFlows.map(item => item.category).sort(), variants: catalogFlows.reduce((total, item) => total + item.variants.length, 0), unverifiedPlansExecutable: false },
      update: { status: 'passed', http: update.response.status, phases: update.response.payload.phases?.map(item => item.phase) },
      remove: { status: 'passed', http: remove.response.status, inventoryInstalled: false },
      rollback: { status: 'passed', http: rollback.status, inventoryInstalled: true },
      injectedFailure: { status: 'passed', phase: 'health', http: failedUpdate.response.status, rollback: rollbackPhase.status },
      byteForByteRecovery: { status: 'passed', packageJsonSha256: hash(afterPackage), lockfileSha256: hash(afterLock) },
      postFailureDumpConfig: { status: 'passed', exitCode: healthyAfterFailure.status },
      cliRescue: { status: 'passed', removeExitCode: rescued.status, reinstallExitCode: recovered.status },
    },
    trustBoundary: {
      writeOrigin: 'loopback-and-same-origin-only',
      clientSubmitsFailurePhase: false,
      failurePhaseConfiguredByHostEnvironment: true,
      userProfileTouched: false,
      credentialsCaptured: false,
    },
    result: 'passed',
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, checks: Object.keys(report.checks).length })}\n`)
} finally {
  if (server !== undefined) await stop(server.child)
  const resolvedHome = resolve(home)
  const guardedRoot = `${resolve(tempRoot)}${sep}`
  if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove UI lifecycle path outside temp root')
  await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
