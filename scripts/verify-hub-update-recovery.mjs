import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInstallPlan, executeInstallPlan } from '../lib/transaction.js'
import { dshCliPath, dshPackageInfo, runDsh } from './dsh-cli-lib.mjs'

const baselineArtifact = resolve(process.argv[2] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.1-recovery-fixture.tgz')
const updateArtifact = resolve(process.argv[3] ?? 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
const output = resolve(process.argv[4] ?? 'evidence/m2-hub-update-recovery-2026-08-17.json')
const tempRoot = resolve(process.env.DSH_HUB_RECOVERY_TEMP_ROOT ?? '../../work/hub-update-recovery')
const packageName = '@harness-flow/dsh-flow-hub'
const baselineVersion = '0.0.1-recovery-fixture'
const updateVersion = '0.0.2-m0'

const sha256 = value => createHash('sha256').update(value).digest('hex')

async function fileHash(path) {
  return sha256(await readFile(path))
}

async function treeHash(root) {
  const records = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      const info = await lstat(path)
      if (info.isSymbolicLink()) records.push(`link\0${name}\0${await readlink(path)}\0`)
      else if (info.isDirectory()) {
        records.push(`dir\0${name}\0`)
        await visit(path)
      } else if (info.isFile()) records.push(`file\0${name}\0${sha256(await readFile(path))}\0`)
      else records.push(`other\0${name}\0${info.mode}\0`)
    }
  }
  await visit(root)
  return sha256(records.join(''))
}

async function profileState(profileDir) {
  const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  return {
    treeSha256: await treeHash(profileDir),
    packageJsonSha256: await fileHash(join(profileDir, 'package.json')),
    lockfileSha256: await fileHash(join(profileDir, 'pnpm-lock.yaml')),
    patchSha256: await fileHash(join(profileDir, 'cordis.patch.yml')),
    hubSpec: pkg.dependencies?.[packageName] ?? null,
  }
}

async function installedVersion(profileDir) {
  const pkg = JSON.parse(await readFile(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'))
  return pkg.version
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

async function webSmoke(cli, home) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  try {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`dsh web exited:${child.exitCode};${stderr}`)
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return response.status
      } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    throw new Error(`dsh web smoke timed out;${stderr}`)
  } finally {
    await stop(child)
  }
}

function requireDsh(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed:${result.stderr}`)
  return result
}

function sameState(left, right) {
  return left.treeSha256 === right.treeSha256
    && left.packageJsonSha256 === right.packageJsonSha256
    && left.lockfileSha256 === right.lockfileSha256
    && left.patchSha256 === right.patchSha256
    && left.hubSpec === right.hubSpec
}

function makePlan(sourceSpec, integrity, dshVersion, now) {
  return createInstallPlan({
    action: 'update',
    profile: 'web',
    packageName,
    sourceSpec,
    version: updateVersion,
    integrity: `sha256-${integrity}`,
    lifecycleScripts: [],
    permissions: ['profile-package-update'],
    credentials: [],
    verification: 'project-owned recovery fixture',
    signature: 'not-applicable-trusted-fixture',
    dshVersion,
    now,
  })
}

await mkdir(tempRoot, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const home = await mkdtemp(join(tempRoot, 'run-'))
const profileDir = join(home, 'profiles', 'web')
const cli = dshCliPath()
const dshVersion = dshPackageInfo().package.version

try {
  requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-default-config']), 'profile bootstrap')
  requireDsh(runDsh(cli, home, ['plugin', '--profile', 'web', 'add', baselineArtifact, '--save-exact', '--ignore-scripts', '--reporter=silent']), 'baseline Hub install')
  requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'baseline dump-config')
  if (await installedVersion(profileDir) !== baselineVersion) throw new Error('baseline Hub version mismatch')
  const initialWeb = await webSmoke(cli, home)
  const before = await profileState(profileDir)
  const updateIntegrity = await fileHash(updateArtifact)

  const incompatible = makePlan(updateArtifact, updateIntegrity, '>=0.2.0 <0.3.0', new Date('2026-08-17T08:00:00.000Z'))
  const incompatibleResult = await executeInstallPlan(incompatible, { home, dshCli: cli, dshVersion, now: () => new Date('2026-08-17T08:00:01.000Z') })
  const afterIncompatible = await profileState(profileDir)
  if (incompatibleResult.ok || !incompatibleResult.error?.startsWith('unsupported-dsh-version:')) throw new Error('incompatible update was not blocked in preflight')
  if (!sameState(before, afterIncompatible)) throw new Error('incompatible preflight changed the Profile')
  if (await installedVersion(profileDir) !== baselineVersion) throw new Error('incompatible update changed installed Hub version')
  const incompatibleWeb = await webSmoke(cli, home)

  const rollbackPlan = makePlan(updateArtifact, updateIntegrity, '>=0.1.0-rc.6 <0.2.0', new Date('2026-08-17T08:01:00.000Z'))
  const rollbackResult = await executeInstallPlan(rollbackPlan, {
    home,
    dshCli: cli,
    dshVersion,
    failAt: 'health',
    now: () => new Date('2026-08-17T08:01:01.000Z'),
  })
  const rollbackPhase = rollbackResult.phases.find(phase => phase.phase === 'rollback')
  if (rollbackResult.ok || rollbackResult.error !== 'injected-failure:health' || rollbackPhase?.status !== 'passed') throw new Error('health failure did not complete rollback')
  const failedProfile = join(home, 'flow-hub', 'failed', rollbackPlan.id)
  if (await installedVersion(failedProfile) !== updateVersion) throw new Error('failed committed Profile did not contain the attempted Hub update')
  const afterRollback = await profileState(profileDir)
  if (!sameState(before, afterRollback)) throw new Error('rollback did not restore the complete prior Profile')
  if (await installedVersion(profileDir) !== baselineVersion) throw new Error('rollback did not restore prior Hub version')
  const finalDump = requireDsh(runDsh(cli, home, ['--profile', 'web', '--dump-config']), 'post-rollback dump-config')
  const finalWeb = await webSmoke(cli, home)

  const report = {
    schemaVersion: 1,
    date: new Date().toISOString(),
    subject: 'Official DSH Hub update preflight and whole-Profile recovery',
    environment: { os: process.platform, arch: process.arch, node: process.version, dsh: dshVersion, profile: 'isolated web' },
    commands: [
      'pnpm run transaction:verify-hub-update-recovery',
      'dsh plugin --profile web add <trusted-baseline-tgz> --save-exact --ignore-scripts',
      'dsh --profile web --dump-config',
    ],
    artifacts: {
      baseline: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.1-recovery-fixture.tgz', version: baselineVersion, sha256: await fileHash(baselineArtifact) },
      update: { file: 'artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz', version: updateVersion, sha256: updateIntegrity },
    },
    checks: {
      baseline: { status: 'passed', version: baselineVersion, web: `HTTP ${initialWeb}` },
      incompatiblePreflight: { status: 'passed', blocked: true, error: 'unsupported-dsh-version', profileUnchanged: true, versionRestored: baselineVersion, web: `HTTP ${incompatibleWeb}` },
      healthFailureRollback: { status: 'passed', failedAt: 'health', rollback: rollbackPhase.status, attemptedVersion: updateVersion, failedProfileRetained: true },
      wholeProfileRecovery: { status: 'passed', treeByteDigestRestored: true, packageJsonRestored: true, lockfileRestored: true, patchRestored: true, versionRestored: baselineVersion },
      postRollbackDumpConfig: { status: 'passed', exitCode: finalDump.status },
      postRollbackWeb: { status: 'passed', http: finalWeb },
    },
    privacy: { userProfileTouched: false, credentialsCaptured: false, privatePathsRecorded: false },
    result: 'passed',
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, checks: Object.keys(report.checks).length })}\n`)
} finally {
  const resolvedHome = resolve(home)
  const guardedRoot = `${resolve(tempRoot)}${sep}`
  if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove Hub recovery path outside temp root')
  await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
