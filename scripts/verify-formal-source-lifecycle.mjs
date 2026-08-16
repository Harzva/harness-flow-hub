import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createInstallPlan, createRollbackPlan, executeInstallPlan, executeRollbackPlan } from '../lib/transaction.js'
import { dshPackageInfo, runDsh } from './dsh-cli-lib.mjs'

const output = resolve(process.argv[2] ?? 'evidence/m2-formal-source-lifecycle-2026-08-17.json')
const tempRoot = resolve(process.env.DSH_FORMAL_SOURCE_TEMP_ROOT ?? '../../work/formal-source-lifecycle')
const packageName = '@harness-flow/hello-bundle'
const v1Tgz = resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const v2Tgz = resolve('artifacts/harness-flow-hello-bundle-0.0.2-m2.tgz')
const registryPort = Number(process.env.DSH_FIXTURE_REGISTRY_PORT ?? 48743)
const registryUrl = `http://127.0.0.1:${registryPort}/`
const { package: dshPackage, cli: dshCli } = dshPackageInfo()

function assert(condition, message) { if (!condition) throw new Error(message) }
function sha(value) { return createHash('sha256').update(value).digest('hex') }

async function startRegistry() {
  const child = spawn(process.execPath, [resolve('scripts/fixture-registry.mjs'), v1Tgz, String(registryPort), v2Tgz], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = await new Promise((resolveReady, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`fixture registry timeout: ${stderr}`)), 10_000)
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
      const line = stdout.split(/\r?\n/, 1)[0]
      if (!line.endsWith('}')) return
      clearTimeout(timer)
      try { resolveReady(JSON.parse(line)) } catch (error) { reject(error) }
    })
    child.once('exit', code => reject(new Error(`fixture registry exited ${code}: ${stderr}`)))
  })
  assert(ready.versions?.join(',') === '0.0.1-m0,0.0.2-m2', 'fixture registry versions mismatch')
  return child
}

function installPlan(action, sourceSpec, networkEndpoint) {
  return createInstallPlan({
    action,
    profile: 'web',
    packageName,
    sourceSpec,
    verification: 'trusted-fixture',
    signature: 'not-applicable-trusted-fixture',
    ...(networkEndpoint ? { networkEndpoint } : {}),
  })
}

async function installedVersion(home) {
  const manifest = JSON.parse(await readFile(join(home, 'profiles', 'web', 'node_modules', '@harness-flow', 'hello-bundle', 'package.json'), 'utf8'))
  return manifest.version
}

async function verifyAdapter(adapter) {
  const home = await mkdtemp(join(tempRoot, `${adapter.kind}-`))
  const manifestPath = join(home, 'profiles', 'web', 'package.json')
  const lockPath = join(home, 'profiles', 'web', 'pnpm-lock.yaml')
  try {
    assert(runDsh(dshCli, home, ['--profile', 'web', '--dump-default-config']).status === 0, `${adapter.kind} bootstrap failed`)
    if (adapter.registry) await writeFile(join(home, 'profiles', 'web', '.npmrc'), `@harness-flow:registry=${adapter.registry}\n`, 'utf8')

    const add = await executeInstallPlan(installPlan('add', adapter.v1, adapter.endpoint), { home, dshCli, dshVersion: dshPackage.version })
    assert(add.ok && await installedVersion(home) === '0.0.1-m0', `${adapter.kind} install v1 failed`)

    const update = await executeInstallPlan(installPlan('update', adapter.v2, adapter.endpoint), { home, dshCli, dshVersion: dshPackage.version })
    assert(update.ok && await installedVersion(home) === '0.0.2-m2', `${adapter.kind} update v2 failed`)

    const rollbackUpdate = await executeRollbackPlan(createRollbackPlan({ profile: 'web', backupId: update.backupId }), { home, dshCli, dshVersion: dshPackage.version })
    assert(rollbackUpdate.ok && await installedVersion(home) === '0.0.1-m0', `${adapter.kind} update rollback failed`)

    const beforeFailureManifest = await readFile(manifestPath)
    const beforeFailureLock = await readFile(lockPath)
    const failedUpdate = await executeInstallPlan(installPlan('update', adapter.v2, adapter.endpoint), {
      home, dshCli, dshVersion: dshPackage.version, failAt: 'health',
    })
    assert(!failedUpdate.ok, `${adapter.kind} injected health failure unexpectedly succeeded`)
    assert(failedUpdate.phases.some(item => item.phase === 'rollback' && item.status === 'passed'), `${adapter.kind} failed update did not rollback`)
    assert(sha(await readFile(manifestPath)) === sha(beforeFailureManifest), `${adapter.kind} failed update changed manifest`)
    assert(sha(await readFile(lockPath)) === sha(beforeFailureLock), `${adapter.kind} failed update changed lockfile`)
    assert(await installedVersion(home) === '0.0.1-m0', `${adapter.kind} failed update changed installed version`)

    const remove = await executeInstallPlan(installPlan('remove', adapter.v1, adapter.endpoint), { home, dshCli, dshVersion: dshPackage.version })
    assert(remove.ok, `${adapter.kind} uninstall failed`)
    const removedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert(removedManifest.dependencies?.[packageName] === undefined, `${adapter.kind} dependency remained after uninstall`)

    const rollbackRemove = await executeRollbackPlan(createRollbackPlan({ profile: 'web', backupId: remove.backupId }), { home, dshCli, dshVersion: dshPackage.version })
    assert(rollbackRemove.ok && await installedVersion(home) === '0.0.1-m0', `${adapter.kind} uninstall rollback failed`)
    assert(runDsh(dshCli, home, ['--profile', 'web', '--dump-config']).status === 0, `${adapter.kind} final dump-config failed`)

    return {
      kind: adapter.kind,
      sources: adapter.publicSources,
      install: { status: 'passed', version: '0.0.1-m0', phases: add.phases.map(item => item.phase) },
      update: { status: 'passed', from: '0.0.1-m0', to: '0.0.2-m2', phases: update.phases.map(item => item.phase) },
      updateRollback: { status: 'passed', restored: '0.0.1-m0', phases: rollbackUpdate.phases.map(item => item.phase) },
      injectedFailure: { status: 'passed', at: 'health', transactionOk: false, rollback: 'passed', byteForByte: true },
      uninstall: { status: 'passed', phases: remove.phases.map(item => item.phase) },
      uninstallRollback: { status: 'passed', restored: '0.0.1-m0', phases: rollbackRemove.phases.map(item => item.phase) },
      officialDumpConfig: 'passed',
    }
  } finally {
    const guardedRoot = `${tempRoot}${sep}`
    if (!home.startsWith(guardedRoot)) throw new Error('refusing to remove formal source verifier home outside temp root')
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
let registry
try {
  registry = await startRegistry()
  const adapters = [
    {
      kind: 'npm',
      v1: `${packageName}@0.0.1-m0`,
      v2: `${packageName}@0.0.2-m2`,
      publicSources: [`${packageName}@0.0.1-m0`, `${packageName}@0.0.2-m2`],
      registry: registryUrl,
      endpoint: `${registryUrl}%40harness-flow%2Fhello-bundle`,
    },
    {
      kind: 'tgz',
      v1: v1Tgz,
      v2: v2Tgz,
      publicSources: ['artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz', 'artifacts/harness-flow-hello-bundle-0.0.2-m2.tgz'],
    },
  ]
  const results = []
  for (const adapter of adapters) results.push(await verifyAdapter(adapter))
  const evidence = {
    schemaVersion: 1,
    subject: 'Formal npm and offline tgz lifecycle through official DSH plugin commands',
    date: new Date().toISOString(),
    environment: { os: process.platform, arch: process.arch, node: process.version, dsh: dshPackage.version },
    commands: ['pnpm run transaction:verify-formal-sources'],
    lifecycle: ['install', 'update', 'update-rollback', 'health-failure-rollback', 'uninstall', 'uninstall-rollback'],
    adapters: results,
    trustBoundary: {
      fixtures: 'project-owned',
      lifecycleScriptsDisabled: true,
      userProfileTouched: false,
      credentialsCaptured: false,
      privatePathsRecorded: false,
    },
    result: 'passed',
  }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, adapters: results.map(item => item.kind), lifecycle: evidence.lifecycle })}\n`)
} finally {
  registry?.kill('SIGTERM')
}
