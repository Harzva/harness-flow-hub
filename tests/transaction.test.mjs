import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInstallPlan, createRollbackPlan, executeInstallPlan, executeRollbackPlan, inferSourceKind, listRecoveryPoints, recoverInterruptedTransactions,
} from '../lib/transaction.js'

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
    sourceSpec: '@harness-flow/hello-bundle@0.0.1', verification: 'trusted-fixture', signature: 'not-applicable-trusted-fixture', now: fixedNow,
  })
}

function fakeDsh(home) {
  return async args => {
    const profileIndex = args.indexOf('--profile')
    const profileName = profileIndex >= 0 ? args[profileIndex + 1] : undefined
    if (typeof profileName !== 'string') return { code: 2, stdout: '', stderr: 'missing profile' }
    const manifestPath = join(home, 'profiles', profileName, 'package.json')
    if (args[0] === 'plugin') {
      const action = args[3]
      if (action === 'install') {
        await readFile(manifestPath, 'utf8')
        return { code: 0, stdout: '', stderr: '' }
      }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (action === 'remove') {
        delete manifest.dependencies['@harness-flow/hello-bundle']
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(item => item !== '@harness-flow/hello-bundle')
      } else {
        manifest.dependencies['@harness-flow/hello-bundle'] = '0.0.1'
        if (!manifest.dsh.profile.bundles.includes('@harness-flow/hello-bundle')) manifest.dsh.profile.bundles.push('@harness-flow/hello-bundle')
      }
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
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, networkProbe: async () => true,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.phases.map(item => item.phase), ['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'relink', 'health', 'complete'])
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
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, networkProbe: async () => true, failAt: 'health',
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
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, networkProbe: async () => true,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /profile-transaction-locked/)
    assert.deepEqual(await readFile(join(fixture.profile, 'package.json')), before)
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('preflight fails closed for platform, DSH, network, credentials, and signature uncertainty', async () => {
  const fixture = await fixtureHome()
  try {
    const base = plan()
    const cases = [
      [{ ...base, requirements: { ...base.requirements, platforms: ['linux'] } }, { runtimePlatform: 'win32', networkProbe: async () => true }, /unsupported-platform/],
      [base, { dshVersion: '0.1.0-rc.5', networkProbe: async () => true }, /unsupported-dsh-version/],
      [base, { networkProbe: async () => false }, /network-preflight-failed/],
      [{ ...base, risk: { ...base.risk, credentials: ['FLOW_TOKEN'] } }, { networkProbe: async () => true, availableCredentials: [] }, /missing-credentials/],
      [{ ...base, risk: { ...base.risk, signature: 'unverified' } }, { networkProbe: async () => true }, /registry-signature-unverified/],
    ]
    for (const [candidate, extra, expected] of cases) {
      const result = await executeInstallPlan(candidate, { home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, ...extra })
      assert.equal(result.ok, false)
      assert.match(result.error, expected)
    }
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('startup recovery restores a Profile interrupted after commit', async () => {
  const fixture = await fixtureHome()
  try {
    const original = await readFile(join(fixture.profile, 'package.json'))
    const result = await executeInstallPlan(plan(), {
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, networkProbe: async () => true,
    })
    assert.equal(result.ok, true)
    const journalPath = join(fixture.home, 'flow-hub', 'transactions', `${plan().id}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.status = 'committed'
    journal.pid = 99999999
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n')
    const recovered = await recoverInterruptedTransactions({ home: fixture.home, now: () => fixedNow, isProcessAlive: () => false })
    assert.equal(recovered.length, 1)
    assert.deepEqual(await readFile(join(fixture.profile, 'package.json')), original)
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('failure injection at every executable phase preserves the original Profile', async () => {
  for (const phase of ['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'relink', 'health', 'complete']) {
    const fixture = await fixtureHome()
    try {
      const before = await readFile(join(fixture.profile, 'package.json'))
      const result = await executeInstallPlan(plan(), {
        home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0,
        networkProbe: async () => true, failAt: phase,
      })
      assert.equal(result.ok, false, `${phase} unexpectedly succeeded`)
      assert.equal(result.phases.find(item => item.phase === 'rollback')?.status, 'passed', `${phase} rollback failed`)
      assert.deepEqual(await readFile(join(fixture.profile, 'package.json')), before, `${phase} changed original Profile`)
    } finally {
      await rm(fixture.home, { recursive: true, force: true })
    }
  }
})

test('structured rollback restores a completed recovery point and retains an undo backup', async () => {
  const fixture = await fixtureHome()
  try {
    const add = await executeInstallPlan(plan(), {
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, networkProbe: async () => true,
    })
    assert.equal(add.ok, true)
    const points = await listRecoveryPoints({ home: fixture.home, profile: 'web' })
    assert.deepEqual(points.map(point => point.backupId), [add.backupId])
    const rollbackPlan = createRollbackPlan({ profile: 'web', backupId: add.backupId, now: new Date('2026-08-16T12:01:00.000Z') })
    const rollback = await executeRollbackPlan(rollbackPlan, {
      home: fixture.home, dshCli: 'unused', now: () => new Date('2026-08-16T12:01:00.000Z'), run: fakeDsh(fixture.home), minimumFreeBytes: 0,
    })
    assert.equal(rollback.ok, true)
    const restored = JSON.parse(await readFile(join(fixture.profile, 'package.json'), 'utf8'))
    assert.equal(restored.dependencies['@harness-flow/hello-bundle'], undefined)
    const undo = JSON.parse(await readFile(join(fixture.home, 'flow-hub', 'backups', rollbackPlan.id, 'web', 'package.json'), 'utf8'))
    assert.equal(undo.dependencies['@harness-flow/hello-bundle'], '0.0.1')
    const nextPoints = await listRecoveryPoints({ home: fixture.home, profile: 'web' })
    assert.ok(nextPoints.some(point => point.backupId === rollbackPlan.id && point.createdBy === 'rollback'))
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('rollback health failure restores the pre-rollback Profile byte-for-byte', async () => {
  const fixture = await fixtureHome()
  try {
    const add = await executeInstallPlan(plan(), {
      home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fakeDsh(fixture.home), minimumFreeBytes: 0, networkProbe: async () => true,
    })
    assert.equal(add.ok, true)
    const installed = await readFile(join(fixture.profile, 'package.json'))
    const rollbackPlan = createRollbackPlan({ profile: 'web', backupId: add.backupId, now: new Date('2026-08-16T12:02:00.000Z') })
    const rollback = await executeRollbackPlan(rollbackPlan, {
      home: fixture.home, dshCli: 'unused', now: () => new Date('2026-08-16T12:02:00.000Z'), run: fakeDsh(fixture.home), minimumFreeBytes: 0, failAt: 'health',
    })
    assert.equal(rollback.ok, false)
    assert.equal(rollback.phases.find(item => item.phase === 'rollback')?.status, 'passed')
    assert.deepEqual(await readFile(join(fixture.profile, 'package.json')), installed)
  } finally {
    await rm(fixture.home, { recursive: true, force: true })
  }
})

test('rollback plan rejects untrusted backup identifiers', () => {
  assert.throws(() => createRollbackPlan({ profile: 'web', backupId: '../escape', now: fixedNow }), /invalid-backup-id/)
})
