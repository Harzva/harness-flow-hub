import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const expectedVersion = process.env.DSH_MATRIX_VERSION?.trim()
const expectedState = process.env.DSH_MATRIX_EXPECTED?.trim()
const role = process.env.DSH_MATRIX_ROLE?.trim() || 'unspecified'
if (expectedVersion === undefined || expectedVersion === '') throw new Error('DSH_MATRIX_VERSION is required')
if (!['compatible', 'unknown', 'incompatible'].includes(expectedState)) throw new Error('DSH_MATRIX_EXPECTED must be compatible, unknown or incompatible')

const artifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
const output = resolve(process.argv[3] ?? `evidence-ci/dsh-matrix/${process.platform}/${role}-${expectedVersion}.json`)
const tempRoot = resolve(process.env.DSH_VERSION_MATRIX_TEMP_ROOT ?? '../../work/dsh-version-matrix')
const packageRoot = resolve(process.env.DSH_PACKAGE_ROOT ?? '')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function requireDsh(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`)
  return result
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

async function startWeb(cli, home) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dsh web exited before readiness: ${child.exitCode}; ${stderr}`)
    try {
      const response = await fetch(`${origin}/flow-hub/api/bootstrap`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return { child, origin }
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  await stop(child)
  throw new Error(`dsh web timed out; ${stderr}`)
}

async function request(origin, path, body) {
  const response = await fetch(`${origin}${path}`, body === undefined ? {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
  } : {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  })
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() }
}

if (packageRoot === resolve('')) throw new Error('DSH_PACKAGE_ROOT is required')
const cli = dshCliPath()
const installedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
if (installedPackage.version !== expectedVersion) throw new Error(`matrix-version-mismatch:${installedPackage.version}:${expectedVersion}`)

await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const home = await mkdtemp(join(tempRoot, 'run-'))
let server

try {
  const versionResult = requireDsh(runDsh(cli, home, ['--version']), 'version check')
  if (versionResult.stdout.trim() !== expectedVersion) throw new Error(`cli-version-mismatch:${versionResult.stdout.trim()}`)
  requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-default-config']), 'profile bootstrap')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', artifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'Hub install')

  server = await startWeb(cli, home)
  const root = await request(server.origin, '/')
  if (root.status !== 200) throw new Error(`DSH Web root returned ${root.status}`)
  const bootstrapResponse = await request(server.origin, '/flow-hub/api/bootstrap')
  if (bootstrapResponse.status !== 200) throw new Error(`Bootstrap returned ${bootstrapResponse.status}`)
  const bootstrap = JSON.parse(bootstrapResponse.text)
  if (bootstrap.dshVersion !== expectedVersion || bootstrap.state !== expectedState || bootstrap.compatibility?.overall !== expectedState) {
    throw new Error(`unexpected-bootstrap:${bootstrap.dshVersion}:${bootstrap.state}`)
  }
  const client = await request(server.origin, '/plugins/@harness-flow/dsh-flow-hub/client.js')
  if (client.status !== 200 || !client.text.includes('@harness-flow/dsh-flow-hub')) throw new Error('client module did not load')

  const reads = {}
  let blockedWrite = null
  if (expectedState === 'compatible') {
    for (const endpoint of ['registry', 'profiles', 'tasks', 'flows']) {
      const response = await request(server.origin, `/flow-hub/api/${endpoint}`)
      const payload = JSON.parse(response.text)
      if (response.status !== 200 || payload.ok !== true) throw new Error(`${endpoint} read failed`)
      reads[endpoint] = response.status
    }
  } else {
    const response = await request(server.origin, '/flow-hub/api/plan', { action: 'add' })
    const payload = JSON.parse(response.text)
    if (response.status !== 409 || payload.error !== 'bootstrap-compatibility-required') throw new Error('safe-mode Host write gate did not fail closed')
    blockedWrite = { http: response.status, error: payload.error, profileMutationAttempted: false }
  }
  await stop(server.child)
  server = undefined

  const beforeRescue = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'pre-rescue dump-config')
  if (!beforeRescue.stdout.includes('harness-flow-hub')) throw new Error('Hub missing before rescue')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'remove', '@harness-flow/dsh-flow-hub', '--reporter=silent']), 'CLI rescue remove')
  const afterRescue = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'post-rescue dump-config')
  if (afterRescue.stdout.includes('harness-flow-hub')) throw new Error('CLI rescue did not remove Hub')

  const report = {
    date: new Date().toISOString(),
    subject: 'Published DSH binary compatibility matrix entry',
    entry: { role, version: expectedVersion, expected: expectedState, observed: bootstrap.state },
    environment: { os: process.platform, arch: process.arch, node: process.version, profile: 'isolated web' },
    artifact: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz', sha256: sha256(await readFile(artifact)) },
    checks: {
      cliVersion: { status: 'passed', value: expectedVersion },
      webBoot: { status: 'passed', http: root.status },
      bootstrap: { status: 'passed', state: bootstrap.state, dimensions: bootstrap.compatibility.dimensions },
      clientModule: { status: 'passed', http: client.status },
      fullUiReads: expectedState === 'compatible' ? { status: 'passed', endpoints: reads } : { status: 'not-applicable' },
      safeModeWriteGate: expectedState !== 'compatible' ? { status: 'passed', ...blockedWrite } : { status: 'not-applicable' },
      cliRescue: { status: 'passed', preDumpConfig: beforeRescue.status, remove: 0, postDumpConfig: afterRescue.status },
    },
    trustBoundary: { userProfileTouched: false, credentialsCaptured: false, browserWriteActionPerformed: false },
    result: 'passed',
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, role, version: expectedVersion, state: bootstrap.state })}\n`)
} finally {
  if (server !== undefined) await stop(server.child)
  const resolvedHome = resolve(home)
  const guardedRoot = `${resolve(tempRoot)}${sep}`
  if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove DSH matrix path outside temp root')
  await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
