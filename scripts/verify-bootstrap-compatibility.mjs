import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const artifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
const output = resolve(process.argv[3] ?? 'evidence/m2-four-dimensional-compatibility-2026-08-16.json')
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

  server = await startWeb(cli, home, '0.2.0')
  const incompatible = await request(server.origin, 'bootstrap')
  if (incompatible.status !== 200) throw new Error(`incompatible bootstrap returned ${incompatible.status}`)
  const incompatibleDimensions = requireFourDimensions(incompatible.payload, 'incompatible')
  if (incompatibleDimensions.dsh.state !== 'incompatible') throw new Error('simulated DSH mismatch was not classified')
  const blockedPlan = await request(server.origin, 'plan', { action: 'add' })
  if (blockedPlan.status !== 409 || blockedPlan.payload.error !== 'bootstrap-compatibility-required') throw new Error('Host write gate did not fail closed')
  await stop(server.child)
  server = undefined

  const postCheck = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'post-check dump-config')
  const baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  const report = {
    date: new Date().toISOString(),
    baseCommit,
    subject: 'Four-dimensional Bootstrap compatibility on an isolated real DSH Web Profile',
    environment: { os: process.platform, arch: process.arch, node: process.version, profile: 'isolated web' },
    artifact: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz', sha256: hash(await readFile(artifact)) },
    checks: {
      current: { status: 'passed', aggregate: current.payload.state, dimensions: currentDimensions },
      simulatedIncompatible: { status: 'passed', aggregate: incompatible.payload.state, dimensions: incompatibleDimensions },
      hostWriteGate: { status: 'passed', http: blockedPlan.status, error: blockedPlan.payload.error, profileMutationAttempted: false },
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
