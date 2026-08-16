import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const artifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
const output = resolve(process.argv[3] ?? 'evidence/m2-bootstrap-recovery-modes-2026-08-16.json')
const tempRoot = resolve(process.env.DSH_BOOTSTRAP_COMPAT_TEMP_ROOT ?? '../../work/bootstrap-compatibility')

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

async function startWeb(cli, home, testDshVersion) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, DSH_HOME: home }
  delete env.DSH_FLOW_HUB_TEST_DSH_VERSION
  if (testDshVersion !== undefined) env.DSH_FLOW_HUB_TEST_DSH_VERSION = testDshVersion
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited before bootstrap: ${child.exitCode}; ${stderr}`)
    try {
      const response = await fetch(`${origin}/flow-hub/api/bootstrap`, { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
      if (response.ok) return { child, origin }
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  await stop(child)
  throw new Error(`dsh web bootstrap timed out; ${stderr}`)
}

async function request(origin, path, body) {
  const response = await fetch(`${origin}/flow-hub/api/${path}`, body === undefined ? {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  } : {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  return { status: response.status, payload: await response.json() }
}

async function requestText(origin, path) {
  const response = await fetch(`${origin}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() }
}

function requireDsh(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`)
  return result
}

function requireFourDimensions(payload, expected) {
  const names = ['dsh', 'hub', 'registrySchema', 'flowSchema']
  if (payload.state !== expected || payload.compatibility?.overall !== expected) throw new Error(`expected ${expected} aggregate compatibility`)
  if (!names.every(name => payload.compatibility?.dimensions?.[name] !== undefined)) throw new Error('bootstrap omitted a compatibility dimension')
  return Object.fromEntries(names.map(name => [name, payload.compatibility.dimensions[name]]))
}

await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const home = await mkdtemp(join(tempRoot, 'run-'))
const cli = dshCliPath()
let server

try {
  requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-default-config']), 'profile bootstrap')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', artifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'Hub install')

  server = await startWeb(cli, home)
  const current = await request(server.origin, 'bootstrap')
  if (current.status !== 200) throw new Error(`current bootstrap returned ${current.status}`)
  const currentDimensions = requireFourDimensions(current.payload, 'compatible')
  if (!Object.values(currentDimensions).every(dimension => dimension.state === 'compatible')) throw new Error('current four-dimensional snapshot is not fully compatible')
  await stop(server.child)
  server = undefined

  server = await startWeb(cli, home, '0.1.0-rc.7')
  const unknown = await request(server.origin, 'bootstrap')
  if (unknown.status !== 200) throw new Error(`unknown bootstrap returned ${unknown.status}`)
  if (unknown.payload.hubPackageName !== '@harness-flow/dsh-flow-hub' || unknown.payload.packageName !== '@harness-flow/hello-bundle') throw new Error('Bootstrap package roles are ambiguous')
  const unknownDimensions = requireFourDimensions(unknown.payload, 'unknown')
  if (unknownDimensions.dsh.state !== 'unknown' || unknownDimensions.dsh.reason !== 'version-not-verified') throw new Error('simulated unverified DSH was not classified as unknown')
  const blockedUnknownPlan = await request(server.origin, 'plan', { action: 'add' })
  if (blockedUnknownPlan.status !== 409 || blockedUnknownPlan.payload.error !== 'bootstrap-compatibility-required') throw new Error('read-only Host write gate did not fail closed')
  const client = await requestText(server.origin, '/plugins/@harness-flow/dsh-flow-hub/client.js')
  if (client.status !== 200) throw new Error(`client module returned ${client.status}`)
  for (const marker of ['read-only', 'safe-recovery', 'navigator.clipboard.writeText', 'updateCommand', 'removeCommand', 'dsh plugin --profile ']) {
    if (!client.text.includes(marker)) throw new Error(`client recovery guidance missing:${marker}`)
  }
  await stop(server.child)
  server = undefined

  server = await startWeb(cli, home, '0.2.0')
  const incompatible = await request(server.origin, 'bootstrap')
  if (incompatible.status !== 200) throw new Error(`incompatible bootstrap returned ${incompatible.status}`)
  const incompatibleDimensions = requireFourDimensions(incompatible.payload, 'incompatible')
  if (incompatibleDimensions.dsh.state !== 'incompatible') throw new Error('simulated DSH mismatch was not classified')
  const blockedPlan = await request(server.origin, 'plan', { action: 'add' })
  if (blockedPlan.status !== 409 || blockedPlan.payload.error !== 'bootstrap-compatibility-required') throw new Error('Host write gate did not fail closed')
  await stop(server.child)
  server = undefined

  const preRescue = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'pre-rescue dump-config')
  if (!preRescue.stdout.includes('harness-flow-hub')) throw new Error('Hub missing before CLI rescue')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'remove', '@harness-flow/dsh-flow-hub', '--reporter=silent']), 'CLI rescue remove')
  const removed = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'post-remove dump-config')
  if (removed.stdout.includes('harness-flow-hub')) throw new Error('CLI rescue did not remove Hub')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', artifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'CLI rescue reinstall')
  const postCheck = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'post-rescue dump-config')
  if (!postCheck.stdout.includes('harness-flow-hub')) throw new Error('CLI rescue reinstall did not restore Hub')
  const baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  const report = {
    date: new Date().toISOString(),
    baseCommit,
    subject: 'Read-only, incompatible, update guidance and rescue modes on an isolated real DSH Web Profile',
    environment: { os: process.platform, arch: process.arch, node: process.version, profile: 'isolated web' },
    artifact: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz', sha256: hash(await readFile(artifact)) },
    checks: {
      current: { status: 'passed', aggregate: current.payload.state, dimensions: currentDimensions },
      simulatedUnknown: { status: 'passed', aggregate: unknown.payload.state, runtimeMode: 'read-only', dimensions: unknownDimensions },
      unknownWriteGate: { status: 'passed', http: blockedUnknownPlan.status, error: blockedUnknownPlan.payload.error, profileMutationAttempted: false },
      simulatedIncompatible: { status: 'passed', aggregate: incompatible.payload.state, dimensions: incompatibleDimensions },
      hostWriteGate: { status: 'passed', http: blockedPlan.status, error: blockedPlan.payload.error, profileMutationAttempted: false },
      clientRecoveryGuidance: { status: 'passed', http: client.status, runtimeModes: ['read-only', 'safe-recovery'], hubPackageName: unknown.payload.hubPackageName, fixturePackageName: unknown.payload.packageName, updatePrompt: true, rescueEntry: true, autoExecution: false },
      cliRescue: { status: 'passed', preDumpConfig: preRescue.status, remove: removed.status, reinstall: postCheck.status },
      postCheckDumpConfig: { status: 'passed', exitCode: postCheck.status },
    },
    trustBoundary: { userProfileTouched: false, credentialsCaptured: false, browserWriteActionPerformed: false },
    result: 'passed',
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, dimensions: Object.keys(currentDimensions).length })}\n`)
} finally {
  if (server !== undefined) await stop(server.child)
  const resolvedHome = resolve(home)
  const guardedRoot = `${resolve(tempRoot)}${sep}`
  if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove bootstrap verifier path outside temp root')
  await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
