import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstallPlan, executeInstallPlan, inferSourceKind } from '../lib/transaction.js'

const fixedNow = new Date('2026-08-16T12:00:00.000Z')

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), 'flow-hub-transaction-'))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  return { home, profile }
}

function plan() {
  return createInstallPlan({
    action: 'add', profile: 'web', packageName: '@harness-flow/hello-bundle',
    sourceSpec: '@harness-flow/hello-bundle@0.0.1', verification: 'trusted-fixture', now: fixedNow,
  })
}

function fakeDsh(home) {
  return async args => {
    const profileIndex = args.indexOf('--profile')
    const profileName = profileIndex >= 0 ? args[profileIndex + 1] : undefined
    if (typeof profileName !== 'string') return { code: 2, stdout: '', stderr: 'missing profile' }
    const manifestPath = join(home, 'profiles', profileName, 'package.json')
    if (args[0] === 'plugin') {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.dependencies['@harness-flow/hello-bundle'] = '0.0.1'
      manifest.dsh.profile.bundles.push('@harness-flow/hello-bundle')
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      return { code: 0, stdout: '', stderr: '' }
    }
    await readFile(manifestPath, 'utf8')
    return { code: 0, stdout: '[]', stderr: '' }
  }
}

test('Install Plan accepts only exact supported source adapters', () => {
  assert.equal(inferSourceKind('@scope/plugin@1.2.3'), 'npm')
  assert.equal(inferSourceKind('github:owner/repo#0123456789abcdef0123456789abcdef01234567'), 'github-sha')
  assert.equal(inferSourceKind('C:\\fixtures\\plugin.tgz'), 'tgz')
  assert.equal(inferSourceKind('../plugin'), 'local-directory')
  assert.throws(() => inferSourceKind('@scope/plugin@latest'), /source-must-be-exact/)
  assert.throws(() => inferSourceKind('github:owner/repo#main'), /source-must-be-exact/)
  assert.deepEqual(plan(), plan())
})

test('transaction stages through official commands and retains a recoverable backup', async () => {
  const fixture = await fixtureHome()
  try {
    const result = await executeInstallPlan(plan(), {
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.phases.map(item => item.phase), ['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'health', 'complete'])
    const installed = JSON.parse(await readFile(join(fixture.profile, 'package.json'), 'utf8'))
    assert.equal(installed.dependencies['@harness-flow/hello-bundle'], '0.0.1')
    const backup = JSON.parse(await readFile(join(fixture.home, 'flow-hub', 'backups', plan().id, 'web', 'package.json'), 'utf8'))
    assert.equal(backup.dependencies['@harness-flow/hello-bundle'], undefined)
    await readFile(join(fixture.home, 'flow-hub', 'snapshots', plan().id, 'plan.json'), 'utf8')
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('failure after atomic commit restores the original Profile byte-for-byte', async () => {
  const fixture = await fixtureHome()
  try {
    const before = await readFile(join(fixture.profile, 'package.json'))
    const result = await executeInstallPlan(plan(), {
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, failAt: 'health',
    })
    assert.equal(result.ok, false)
    assert.equal(result.phases.find(item => item.phase === 'rollback')?.status, 'passed')
    assert.deepEqual(await readFile(join(fixture.profile, 'package.json')), before)
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('existing per-Profile lock rejects a second writer without touching the Profile', async () => {
  const fixture = await fixtureHome()
  try {
    const before = await readFile(join(fixture.profile, 'package.json'))
    await mkdir(join(fixture.home, 'flow-hub', 'locks', 'web.lock'), { recursive: true })
    const result = await executeInstallPlan(plan(), {
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /profile-transaction-locked/)
    assert.deepEqual(await readFile(join(fixture.profile, 'package.json')), before)
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})
