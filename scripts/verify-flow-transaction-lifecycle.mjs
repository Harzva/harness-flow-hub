import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { compileFlowInstallPlan } from '../lib/flow-resolver.js'
import { executeFlowInstallPlan } from '../lib/transaction.js'
import { runDsh } from './dsh-cli-lib.mjs'

const projectRoot = resolve('.')
const fixture = resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const output = resolve(process.argv[2] ?? 'evidence/m2-flow-transaction-lifecycle-2026-08-16.json')
const tempRoot = resolve('../../work/flow-transaction-verifier')
const require = createRequire(import.meta.url)
const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
const dshCli = resolve(dirname(packagePath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh)

function assert(condition, message) { if (!condition) throw new Error(message) }

async function freePort() {
  const server = createServer()
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise(closed => server.close(closed))
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

async function bootSmoke(profile, env) {
  const port = await freePort()
  const child = spawn(process.execPath, [dshCli, '--profile', profile, '--host', '127.0.0.1', '--port', String(port)], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  try {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return { code: child.exitCode, stdout: '', stderr: 'web process exited before health check' }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return { code: 0, stdout: `HTTP ${response.status}`, stderr: '' }
      } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    return { code: 1, stdout: '', stderr: 'web health check timed out' }
  } finally {
    await stop(child)
  }
}

await stat(fixture)
await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const home = await mkdtemp(join(tempRoot, 'dsh-home-'))

try {
  const integrity = `sha512:${createHash('sha512').update(await readFile(fixture)).digest('hex')}`
  const relativeSpec = `./${relative(projectRoot, fixture).replaceAll('\\', '/')}`
  const flow = {
    schemaVersion: 1,
    id: 'trusted-flow-transaction-fixture', name: 'Trusted Flow Transaction Fixture', version: '0.0.1', category: 'work-environment',
    goal: 'Verify an atomic Flow install through official DSH commands', targetUsers: ['CI'], expectedOutputs: ['healthy isolated Profile'],
    variants: { safe: {
      role: 'Trusted lifecycle verifier', boundaries: ['fixture only'], model: { recommended: 'fixture', constraints: ['none'] },
      skills: [{ id: 'verify', purpose: 'verify lifecycle' }],
      plugins: [{ package: '@harness-flow/hello-bundle', range: '0.0.1-m0', relationship: 'required' }],
      memory: [{ id: 'none', scope: 'fixture', retention: 'transaction' }],
      workflows: [{ id: 'boot', goal: 'boot fixture', steps: ['install', 'boot'] }],
      permissionsPreset: 'fixture-safe', uiExtensions: [], defaults: { profileTemplate: 'web' },
      platforms: [process.platform], credentials: [],
    } },
    validation: [{ id: 'web-health', kind: 'profile-boot', description: 'Web root returns HTTP 200' }],
    uninstall: ['remove isolated fixture Profile'],
  }
  const candidate = {
    package: '@harness-flow/hello-bundle', version: '0.0.1-m0',
    source: { kind: 'tgz', spec: relativeSpec, integrity },
    compatibility: { dsh: '>=0.1.0-rc.6 <0.2.0' }, platforms: [process.platform], lifecycleScripts: {}, permissions: [], credentials: [],
    verification: { state: 'passed' },
  }
  const plan = compileFlowInstallPlan(flow, 'safe', [candidate], {
    generatedAt: '2026-08-16T00:00:00.000Z', dshVersion: pkg.version, platform: process.platform,
    arch: process.arch, node: process.version, profile: 'flow-trusted-fixture', registrySignature: 'verified',
  })
  assert(plan.executable, `trusted fixture plan blocked: ${plan.blockers.join(',')}`)
  const result = await executeFlowInstallPlan(plan, { home, dshCli, dshVersion: pkg.version, bootSmoke })
  assert(result.ok, `Flow transaction failed: ${result.error ?? 'unknown'}`)
  const manifest = JSON.parse(await readFile(join(home, 'profiles', plan.profile.name, 'package.json'), 'utf8'))
  assert(typeof manifest.dependencies?.['@harness-flow/hello-bundle'] === 'string', 'trusted fixture dependency missing')
  assert(manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app'), 'web template bundle missing')
  assert(manifest.dsh?.profile?.bundles?.includes('@harness-flow/hello-bundle'), 'fixture bundle missing')
  const stack = JSON.parse(await readFile(join(home, 'profiles', plan.profile.name, `${flow.id}.stack.lock.json`), 'utf8'))
  assert(JSON.stringify(stack) === JSON.stringify(plan.stack), 'persisted Stack lock differs from plan')
  const dump = runDsh(dshCli, home, ['--profile', plan.profile.name, '--dump-config'])
  assert(dump.status === 0 && dump.stdout.includes('harness-flow-hello'), 'committed Flow Profile failed official dump-config')
  const report = {
    milestone: 'M2-flow-aggregate-transaction-real-lifecycle', date: new Date().toISOString(), dshVersion: pkg.version,
    fixture: 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz', privatePathsRecorded: false,
    profile: plan.profile.name, template: plan.profile.template, planId: plan.id,
    operations: plan.operations.map(item => `${item.package}@${item.version}`),
    steps: result.steps, stackLock: `${flow.id}.stack.lock.json`, officialDumpConfig: 'passed', stagedAndFinalBootSmoke: 'HTTP 200',
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, steps: result.steps.length, dshVersion: pkg.version })}\n`)
} finally {
  const guardedRoot = `${tempRoot}${sep}`
  if (!home.startsWith(guardedRoot)) throw new Error('refusing to remove Flow verifier home outside temp root')
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
