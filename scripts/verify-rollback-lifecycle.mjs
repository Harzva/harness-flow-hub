import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createInstallPlan, createRollbackPlan, executeInstallPlan, executeRollbackPlan, listRecoveryPoints } from '../lib/transaction.js'
import { dshPackageInfo, runDsh } from './dsh-cli-lib.mjs'

const fixture = resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const output = resolve(process.argv[2] ?? 'evidence/m2-rollback-lifecycle-2026-08-16.json')
const tempRoot = resolve('../../work/rollback-verifier')
const { package: pkg, cli: dshCli } = dshPackageInfo()
await mkdir(tempRoot, { recursive: true })
const home = await mkdtemp(join(tempRoot, 'dsh-home-'))

function sha(buffer) { return createHash('sha256').update(buffer).digest('hex') }
function assert(condition, message) { if (!condition) throw new Error(message) }
function manifestPath() { return join(home, 'profiles', 'web', 'package.json') }

await mkdir(dirname(output), { recursive: true })
try {
  const bootstrap = runDsh(dshCli, home, ['--profile', 'web', '--dump-default-config'])
  assert(bootstrap.status === 0, 'official web profile bootstrap failed')
  const addPlan = createInstallPlan({
    action: 'add', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: fixture,
    verification: 'trusted-fixture', signature: 'not-applicable-trusted-fixture', now: new Date('2026-08-16T13:00:00.000Z'),
  })
  const add = await executeInstallPlan(addPlan, { home, dshCli, dshVersion: pkg.version, now: () => new Date('2026-08-16T13:00:00.000Z') })
  assert(add.ok, `install failed: ${add.error ?? 'unknown'}`)
  const installedBytes = await readFile(manifestPath())

  const pointsBefore = await listRecoveryPoints({ home, profile: 'web' })
  assert(pointsBefore.some(point => point.backupId === add.backupId), 'install recovery point missing')
  const removeByRollbackPlan = createRollbackPlan({ profile: 'web', backupId: add.backupId, now: new Date('2026-08-16T13:01:00.000Z') })
  const removeByRollback = await executeRollbackPlan(removeByRollbackPlan, { home, dshCli, dshVersion: pkg.version, now: () => new Date('2026-08-16T13:01:00.000Z') })
  assert(removeByRollback.ok, `rollback to pre-install failed: ${removeByRollback.error ?? 'unknown'}`)
  const removedManifest = JSON.parse(await readFile(manifestPath(), 'utf8'))
  assert(removedManifest.dependencies?.['@harness-flow/hello-bundle'] === undefined, 'rollback did not restore pre-install state')
  assert(runDsh(dshCli, home, ['--profile', 'web', '--dump-config']).status === 0, 'pre-install recovery point failed dump-config')

  const undoPlan = createRollbackPlan({ profile: 'web', backupId: removeByRollback.backupId, now: new Date('2026-08-16T13:02:00.000Z') })
  const undo = await executeRollbackPlan(undoPlan, { home, dshCli, dshVersion: pkg.version, now: () => new Date('2026-08-16T13:02:00.000Z') })
  assert(undo.ok, `undo rollback failed: ${undo.error ?? 'unknown'}`)
  assert(sha(await readFile(manifestPath())) === sha(installedBytes), 'undo rollback did not restore installed manifest byte-for-byte')
  assert(runDsh(dshCli, home, ['--profile', 'web', '--dump-config']).status === 0, 'undo recovery point failed dump-config')

  const beforeFailure = await readFile(manifestPath())
  const failurePlan = createRollbackPlan({ profile: 'web', backupId: add.backupId, now: new Date('2026-08-16T13:03:00.000Z') })
  const injectedFailure = await executeRollbackPlan(failurePlan, {
    home, dshCli, dshVersion: pkg.version, now: () => new Date('2026-08-16T13:03:00.000Z'), failAt: 'health',
  })
  assert(!injectedFailure.ok, 'injected rollback health failure unexpectedly succeeded')
  assert(injectedFailure.phases.some(item => item.phase === 'rollback' && item.status === 'passed'), 'failed rollback operation did not restore current Profile')
  assert(sha(await readFile(manifestPath())) === sha(beforeFailure), 'failed rollback operation changed current Profile')
  assert(runDsh(dshCli, home, ['--profile', 'web', '--dump-config']).status === 0, 'Profile failed dump-config after rollback-operation recovery')

  const evidence = {
    milestone: 'M2-native-recovery-points', date: new Date().toISOString(), dshVersion: pkg.version, privatePathsRecorded: false,
    install: { ok: true, backupId: add.backupId },
    rollbackToPreInstall: { ok: true, planId: removeByRollback.planId, phases: removeByRollback.phases, officialDumpConfig: 'passed' },
    undoRollback: { ok: true, planId: undo.planId, manifestRestoredByteForByte: true, officialDumpConfig: 'passed' },
    injectedRollbackFailure: { at: 'health', ok: false, restoredCurrentProfileByteForByte: true, officialDumpConfig: 'passed', phases: injectedFailure.phases },
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, dshVersion: pkg.version, rollback: true, undo: true, failureRecovery: true })}\n`)
} finally {
  const guardedRoot = `${tempRoot}${sep}`
  if (!home.startsWith(guardedRoot)) throw new Error('refusing to remove verifier home outside temp root')
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
