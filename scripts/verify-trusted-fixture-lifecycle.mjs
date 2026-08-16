import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const artifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const output = resolve(process.argv[3] ?? 'evidence/trusted-fixture-lifecycle-2026-08-16.json')
const tempRoot = resolve(process.env.DSH_VERIFIER_TEMP_ROOT ?? '../../work/trusted-fixture-lifecycle')
const packageName = '@harness-flow/hello-bundle'
const dshVersion = process.env.DSH_VERSION ?? '0.1.0-rc.6'

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise(resolveClosed => server.close(resolveClosed))
  return port
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`web process exited before health check: ${child.exitCode}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return response.status
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error('web health check timed out')
}

async function stop(child) {
  if (child.exitCode !== null) return child.exitCode
  child.kill('SIGTERM')
  const exit = await Promise.race([
    new Promise(resolveExit => child.once('exit', code => resolveExit(code))),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 10_000)),
  ])
  if (exit === 'timeout') child.kill('SIGKILL')
  return exit
}

await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const home = await mkdtemp(join(tempRoot, 'hello-'))
const cli = dshCliPath()
let child
const checks = []

try {
  const bootstrap = runDsh(cli, home, ['--profile', 'web', '--dump-default-config'])
  if (bootstrap.status !== 0) throw new Error('official profile bootstrap failed')
  checks.push({ id: 'profile-bootstrap', status: 'passed' })

  const packagePath = join(home, 'profiles', 'web', 'package.json')
  const lockPath = join(home, 'profiles', 'web', 'pnpm-lock.yaml')
  const baselinePackage = await readFile(packagePath)
  const baselineLock = await readFile(lockPath).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })

  const add = runDsh(cli, home, ['plugin', '--profile', 'web', 'add', artifact, '--save-exact', '--ignore-scripts', '--reporter=silent'])
  if (add.status !== 0) throw new Error('trusted fixture installation failed')
  checks.push({ id: 'install', status: 'passed' })

  const dump = runDsh(cli, home, ['--profile', 'web', '--dump-config'])
  if (dump.status !== 0 || !dump.stdout.includes('harness-flow-hello')) throw new Error('installed fixture is absent from dump-config')
  checks.push({ id: 'dump-config', status: 'passed' })

  const port = await freePort()
  child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const healthStatus = await waitForHealth(`http://127.0.0.1:${port}/`, child)
  checks.push({ id: 'boot-and-health', status: 'passed', detail: `HTTP ${healthStatus}` })
  await stop(child)
  child = undefined

  const remove = runDsh(cli, home, ['plugin', '--profile', 'web', 'remove', packageName, '--reporter=silent'])
  if (remove.status !== 0) throw new Error('trusted fixture removal failed')
  checks.push({ id: 'uninstall', status: 'passed' })

  const reinstall = runDsh(cli, home, ['plugin', '--profile', 'web', 'add', artifact, '--save-exact', '--ignore-scripts', '--reporter=silent'])
  if (reinstall.status !== 0) throw new Error('trusted fixture recovery setup failed')
  const cleanup = runDsh(cli, home, ['plugin', '--profile', 'web', 'remove', packageName, '--reporter=silent'])
  if (cleanup.status !== 0) throw new Error('trusted fixture recovery cleanup failed')
  await writeFile(packagePath, baselinePackage)
  if (baselineLock === null) await rm(lockPath, { force: true })
  else await writeFile(lockPath, baselineLock)
  const recoveredDump = runDsh(cli, home, ['--profile', 'web', '--dump-config'])
  if (recoveredDump.status !== 0 || recoveredDump.stdout.includes('harness-flow-hello')) throw new Error('recovered profile still loads trusted fixture')
  const recoveredLock = await readFile(lockPath).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const restored = hash(await readFile(packagePath)) === hash(baselinePackage)
    && (baselineLock === null ? recoveredLock === null : recoveredLock !== null && hash(recoveredLock) === hash(baselineLock))
  if (!restored) throw new Error('profile snapshots were not restored byte-for-byte')
  checks.push({ id: 'snapshot-recovery', status: 'passed', detail: 'package.json and pnpm-lock.yaml restored byte-for-byte' })

  const report = {
    schemaVersion: 1,
    subject: packageName,
    state: 'passed',
    verifiedAt: new Date().toISOString(),
    environment: { os: process.platform, arch: process.arch, node: process.version, dsh: dshVersion },
    checks,
    evidence: ['evidence/trusted-fixture-lifecycle-2026-08-16.json'],
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, checks: checks.length })}\n`)
} finally {
  if (child !== undefined) await stop(child)
  const resolvedHome = resolve(home)
  const guardedRoot = `${resolve(tempRoot)}${sep}`
  if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove trusted verifier path outside temp root')
  await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
