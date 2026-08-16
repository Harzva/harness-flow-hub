import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { dshCliPath } from './dsh-cli-lib.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.DSH_THIRD_PARTY_RUNTIME_ALLOWED !== 'hosted-ephemeral') {
  throw new Error('third-party runtime verification is restricted to an explicitly enabled GitHub-hosted ephemeral runner')
}

const policyPath = resolve(process.argv[2] ?? 'registry/audits/flow-dependency-policy.json')
const outputDir = resolve(process.argv[3] ?? `evidence/flow-dependency-runtime/${process.platform}`)
const runnerTemp = resolve(process.env.RUNNER_TEMP ?? '')
if (runnerTemp === resolve('')) throw new Error('RUNNER_TEMP is required')
const tempRoot = join(runnerTemp, 'harness-flow-runtime-verifier')
const policy = JSON.parse(await readFile(policyPath, 'utf8'))
const cli = dshCliPath()

function safeEnvironment(home) {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles',
  ]
  const env = {}
  for (const name of allowed) if (typeof process.env[name] === 'string') env[name] = process.env[name]
  return { ...env, DSH_HOME: home, CI: 'true', NO_COLOR: '1' }
}

function runDsh(home, args, timeout = 180_000) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: safeEnvironment(home), encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
  })
}

function requireExit(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 'none'}`)
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
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const result = await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 10_000)),
  ])
  if (result === 'timeout') child.kill('SIGKILL')
}

async function startWeb(home) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env: safeEnvironment(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-2_000) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH Web exited before health check with ${child.exitCode}`)
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return { child, origin, port }
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  await stop(child)
  void stderr
  throw new Error('DSH Web health check timed out')
}

async function tcpProbe(port) {
  await new Promise((resolveConnect, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(3_000)
    socket.once('connect', () => { socket.end(); resolveConnect() })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('loopback bridge timeout')) })
    socket.once('error', reject)
  })
}

async function candidateProbe(item, server) {
  if (item.package === 'dsh-science-workbench') {
    const response = await fetch(`${server.origin}/biowb/listProjects`, { signal: AbortSignal.timeout(5_000) })
    const body = await response.json()
    if (!response.ok || !Array.isArray(body)) throw new Error('science workbench read-only route failed')
    return 'read-only-list-projects'
  }
  if (item.package === 'dsh-frontend-tools-bridge') {
    await tcpProbe(31870)
    return 'authenticated-loopback-port-listening'
  }
  if (item.package === 'dsh-vision-router') {
    const response = await fetch(`${server.origin}/_dsh/vision-router/self-update`, { method: 'GET', signal: AbortSignal.timeout(5_000) })
    if (response.status !== 405) throw new Error('vision self-update route did not reject GET')
    return 'self-update-get-rejected-without-action'
  }
  return 'process-remained-healthy'
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/[A-Za-z]:[\\/][^\s;]+|\/(?:home|Users|tmp)\/[^\s;]+/g, '<redacted-path>').slice(0, 300)
}

await mkdir(tempRoot, { recursive: true })
await mkdir(outputDir, { recursive: true })
const records = []
for (const item of policy.packages.filter(candidate => candidate.hostedBootEligible)) {
  const home = await mkdtemp(join(tempRoot, `${item.package}-`))
  let server
  const checks = []
  try {
    requireExit(runDsh(home, ['--profile', 'web', '--dump-default-config']), 'profile bootstrap')
    checks.push({ id: 'profile-bootstrap', status: 'passed' })
    requireExit(runDsh(home, ['plugin', '--profile', 'web', 'add', `${item.package}@${item.version}`, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'package install')
    checks.push({ id: 'package-install', status: 'passed', detail: 'exact npm version; lifecycle scripts disabled' })
    const profileManifest = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    if (profileManifest.dependencies?.[item.package] === undefined) throw new Error('exact dependency was not recorded')
    const lock = await readFile(join(home, 'profiles', 'web', 'pnpm-lock.yaml'), 'utf8')
    if (!lock.includes(item.integrity.slice('sha512-'.length))) throw new Error('lockfile integrity does not match policy')
    checks.push({ id: 'lock-integrity', status: 'passed' })
    const dump = requireExit(runDsh(home, ['--profile', 'web', '--dump-config']), 'dump-config')
    if (!dump.stdout.includes(item.package)) throw new Error('bundle missing from dump-config')
    checks.push({ id: 'dump-config', status: 'passed' })
    server = await startWeb(home)
    checks.push({ id: 'plugin-boot', status: 'passed' })
    const probe = await candidateProbe(item, server)
    checks.push({ id: 'bounded-health-probe', status: 'passed', detail: probe })
    await stop(server.child)
    server = undefined
    requireExit(runDsh(home, ['plugin', '--profile', 'web', 'remove', item.package, '--reporter=silent']), 'package remove')
    const after = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    if (after.dependencies?.[item.package] !== undefined) throw new Error('dependency remained after remove')
    checks.push({ id: 'package-remove', status: 'passed' })
    const recovered = await startWeb(home)
    await stop(recovered.child)
    checks.push({ id: 'post-remove-profile-health', status: 'passed' })
    records.push({ package: item.package, version: item.version, state: 'passed', checks })
  } catch (error) {
    records.push({ package: item.package, version: item.version, state: 'failed', checks: [...checks, { id: 'runtime-verification', status: 'failed', detail: publicError(error) }] })
  } finally {
    if (server !== undefined) await stop(server.child)
    const resolvedHome = resolve(home)
    const guard = `${resolve(tempRoot)}${sep}`
    if (!resolvedHome.startsWith(guard)) throw new Error('refusing to remove runtime verifier path outside guarded root')
    await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

const passed = records.filter(record => record.state === 'passed').length
const evidence = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  subject: 'Five exact initial Flow dependencies on a GitHub-hosted ephemeral runner',
  environment: { os: process.platform, arch: process.arch, node: process.version, dsh: '0.1.0-rc.6', runner: 'github-hosted-ephemeral' },
  isolation: {
    freshDshHomePerCandidate: true,
    lifecycleScriptsDisabled: true,
    childEnvironmentAllowlisted: true,
    repositorySecretsForwarded: false,
    credentialsConfigured: false,
    userContentUsed: false,
    outboundNetworkBlocked: false,
  },
  records,
  result: passed === records.length ? 'passed' : 'failed',
  scope: 'Functional install, config composition, process boot, bounded health probe, uninstall, and post-remove recovery. This is not a security certification or a complete Flow workflow smoke test.',
}
const output = join(outputDir, `m3-flow-dependency-runtime-${process.platform}-2026-08-17.json`)
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: evidence.result === 'passed', output: basename(output), passed, total: records.length })}\n`)
if (evidence.result !== 'passed') process.exitCode = 1
