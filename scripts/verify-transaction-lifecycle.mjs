import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInstallPlan, executeInstallPlan } from '../lib/transaction.js'
import { runDsh } from './dsh-cli-lib.mjs'

const projectRoot = resolve('.')
const fixture = resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const output = resolve(process.argv[2] ?? 'evidence/m2-transaction-lifecycle-2026-08-16.json')
const tempRoot = resolve('../../work/transaction-verifier')
const require = createRequire(import.meta.url)
const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
const dshCli = resolve(dirname(packagePath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh)
await mkdir(tempRoot, { recursive: true })
const home = await mkdtemp(join(tempRoot, 'dsh-home-'))

function sha(buffer) { return createHash('sha256').update(buffer).digest('hex') }
function assert(condition, message) { if (!condition) throw new Error(message) }

await mkdir(dirname(output), { recursive: true })
let evidence
try {
  const bootstrap = runDsh(dshCli, home, ['--profile', 'web', '--dump-default-config'])
  assert(bootstrap.status === 0, 'official web profile bootstrap failed')

  const addPlan = createInstallPlan({
    action: 'add', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: fixture,
    verification: 'trusted-fixture',
    signature: 'not-applicable-trusted-fixture',
  })
  const add = await executeInstallPlan(addPlan, { home, dshCli, dshVersion: pkg.version })
  assert(add.ok, `transactional add failed: ${add.error ?? 'unknown'}`)
  const manifestPath = join(home, 'profiles', 'web', 'package.json')
  const lockPath = join(home, 'profiles', 'web', 'pnpm-lock.yaml')
  const beforeFailureManifest = await readFile(manifestPath)
  const beforeFailureLock = await readFile(lockPath)
  const installedManifest = JSON.parse(beforeFailureManifest.toString('utf8'))
  assert(typeof installedManifest.dependencies?.['@harness-flow/hello-bundle'] === 'string', 'hello dependency missing after add')

  const updatePlan = createInstallPlan({
    action: 'update', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: fixture,
    verification: 'trusted-fixture',
    signature: 'not-applicable-trusted-fixture',
  })
  const injectedFailure = await executeInstallPlan(updatePlan, { home, dshCli, dshVersion: pkg.version, failAt: 'health' })
  assert(!injectedFailure.ok, 'injected health failure unexpectedly succeeded')
  assert(injectedFailure.phases.some(item => item.phase === 'rollback' && item.status === 'passed'), 'rollback did not pass')
  const afterFailureManifest = await readFile(manifestPath)
  const afterFailureLock = await readFile(lockPath)
  assert(sha(afterFailureManifest) === sha(beforeFailureManifest), 'manifest was not restored byte-for-byte')
  assert(sha(afterFailureLock) === sha(beforeFailureLock), 'lockfile was not restored byte-for-byte')
  const afterRollbackDump = runDsh(dshCli, home, ['--profile', 'web', '--dump-config'])
  assert(afterRollbackDump.status === 0, 'restored profile failed official dump-config')

  const removePlan = createInstallPlan({
    action: 'remove', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: fixture,
    verification: 'trusted-fixture',
    signature: 'not-applicable-trusted-fixture',
  })
  const remove = await executeInstallPlan(removePlan, { home, dshCli, dshVersion: pkg.version })
  assert(remove.ok, `transactional remove failed: ${remove.error ?? 'unknown'}`)
  const removedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert(removedManifest.dependencies?.['@harness-flow/hello-bundle'] === undefined, 'hello dependency remained after remove')
  const finalDump = runDsh(dshCli, home, ['--profile', 'web', '--dump-config'])
  assert(finalDump.status === 0, 'final profile failed official dump-config')

  evidence = {
    milestone: 'M2-transaction-installer-real-lifecycle',
    date: new Date().toISOString(),
    dshVersion: pkg.version,
    fixture: relative(projectRoot, fixture).replaceAll('\\', '/'),
    privatePathsRecorded: false,
    add: { ok: add.ok, phases: add.phases, backupRetained: typeof add.backupId === 'string' },
    injectedFailure: {
      at: 'health', ok: injectedFailure.ok, phases: injectedFailure.phases,
      manifestRestoredByteForByte: true, lockfileRestoredByteForByte: true, officialDumpConfigAfterRollback: 'passed',
    },
    remove: { ok: remove.ok, phases: remove.phases, officialDumpConfigAfterRemove: 'passed' },
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, dshVersion: pkg.version, addPhases: add.phases.length, rollback: true, removePhases: remove.phases.length })}\n`)
} finally {
  const guardedRoot = `${tempRoot}${sep}`
  if (!home.startsWith(guardedRoot)) throw new Error('refusing to remove verifier home outside temp root')
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
