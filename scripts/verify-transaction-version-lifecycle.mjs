import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createInstallPlan, executeInstallPlan } from '../lib/transaction.js'
import { runDsh } from './dsh-cli-lib.mjs'

const output = resolve(process.argv[2] ?? 'evidence/m2-transaction-version-lifecycle-2026-08-16.json')
const tempRoot = resolve('../../work/transaction-version-verifier')
const stableTgz = resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const require = createRequire(import.meta.url)
const dshPackagePath = require.resolve('@deepseek-ai/dsh/package.json')
const dshPackage = JSON.parse(await readFile(dshPackagePath, 'utf8'))
const dshCli = resolve(dirname(dshPackagePath), typeof dshPackage.bin === 'string' ? dshPackage.bin : dshPackage.bin.dsh)
await mkdir(tempRoot, { recursive: true })
const runRoot = await mkdtemp(join(tempRoot, 'run-'))
const home = join(runRoot, 'home')
const v2Source = join(runRoot, 'hello-v2')
const packed = join(runRoot, 'packed')

function assert(condition, message) { if (!condition) throw new Error(message) }
function plan(action, sourceSpec) {
  return createInstallPlan({
    action, profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec,
    verification: 'trusted-fixture', signature: 'not-applicable-trusted-fixture',
  })
}

await mkdir(dirname(output), { recursive: true })
try {
  await cp(resolve('fixtures/hello-bundle'), v2Source, { recursive: true })
  const v2ManifestPath = join(v2Source, 'package.json')
  const v2Manifest = JSON.parse(await readFile(v2ManifestPath, 'utf8'))
  v2Manifest.version = '0.0.2-m2'
  await writeFile(v2ManifestPath, JSON.stringify(v2Manifest, null, 2) + '\n', 'utf8')
  await mkdir(packed, { recursive: true })
  const packCommand = 'pnpm pack --pack-destination ../packed'
  const pack = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', packCommand], { cwd: v2Source, encoding: 'utf8', windowsHide: true })
  assert(pack.status === 0, `fixture v2 pack failed (${pack.status}): ${pack.error?.message ?? ''} ${pack.stderr ?? ''} ${pack.stdout ?? ''}`)
  const v2Tgz = join(packed, 'harness-flow-hello-bundle-0.0.2-m2.tgz')

  const bootstrap = runDsh(dshCli, home, ['--profile', 'web', '--dump-default-config'])
  assert(bootstrap.status === 0, 'official web profile bootstrap failed')
  const installV2 = await executeInstallPlan(plan('add', v2Tgz), { home, dshCli, dshVersion: dshPackage.version })
  assert(installV2.ok, `v2 install failed: ${installV2.error ?? 'unknown'}`)
  const installedV2 = JSON.parse(await readFile(join(home, 'profiles', 'web', 'node_modules', '@harness-flow', 'hello-bundle', 'package.json'), 'utf8')).version
  assert(installedV2 === '0.0.2-m2', `expected v2, got ${installedV2}`)

  const downgrade = await executeInstallPlan(plan('update', stableTgz), { home, dshCli, dshVersion: dshPackage.version })
  assert(downgrade.ok, `downgrade failed: ${downgrade.error ?? 'unknown'}`)
  const installedV1 = JSON.parse(await readFile(join(home, 'profiles', 'web', 'node_modules', '@harness-flow', 'hello-bundle', 'package.json'), 'utf8')).version
  assert(installedV1 === '0.0.1-m0', `expected v1 after downgrade, got ${installedV1}`)
  const dump = runDsh(dshCli, home, ['--profile', 'web', '--dump-config'])
  assert(dump.status === 0, 'downgraded profile failed official dump-config')

  const remove = await executeInstallPlan(plan('remove', stableTgz), { home, dshCli, dshVersion: dshPackage.version })
  assert(remove.ok, `remove after downgrade failed: ${remove.error ?? 'unknown'}`)
  const evidence = {
    milestone: 'M2-update-downgrade-uninstall', date: new Date().toISOString(), dshVersion: dshPackage.version,
    privatePathsRecorded: false, install: { from: null, to: '0.0.2-m2', ok: true, phases: installV2.phases },
    downgrade: { from: '0.0.2-m2', to: '0.0.1-m0', ok: true, phases: downgrade.phases, officialDumpConfig: 'passed' },
    uninstall: { from: '0.0.1-m0', to: null, ok: true, phases: remove.phases },
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, install: installedV2, downgrade: installedV1, uninstall: true })}\n`)
} finally {
  const guardedRoot = `${tempRoot}${sep}`
  if (!runRoot.startsWith(guardedRoot)) throw new Error('refusing to remove verifier root outside temp root')
  await rm(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
