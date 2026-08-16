import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { compileFlowInstallPlan } from '../lib/flow-resolver.js'
import { executeFlowInstallPlan, recoverInterruptedFlowTransactions } from '../lib/transaction.js'

const fixedNow = new Date('2026-08-16T14:00:00.000Z')

async function fixturePlan() {
  const flow = parseYaml(await readFile('registry/flows/coding-expert.dsh-flow.yml', 'utf8'))
  const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
  const trusted = structuredClone(registry.plugins)
  for (const candidate of trusted.filter(item => ['dsh-mnemon', 'dsh-openwolf'].includes(item.package))) {
    candidate.verification.state = 'passed'
    candidate.compatibility.dsh = '>=0.1.0-rc.6 <0.2.0'
    candidate.platforms = ['linux']
  }
  return compileFlowInstallPlan(flow, 'lite', trusted, {
    generatedAt: fixedNow.toISOString(), dshVersion: '0.1.0-rc.6', platform: 'linux', arch: 'x64', node: 'v24.0.0', registrySignature: 'verified',
  })
}

async function exists(path) {
  try { await stat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function fakeFlowDsh(home) {
  return async args => {
    const profileIndex = args.indexOf('--profile')
    const profileName = profileIndex >= 0 ? args[profileIndex + 1] : undefined
    if (typeof profileName !== 'string') return { code: 2, stdout: '', stderr: 'missing profile' }
    const profileDir = join(home, 'profiles', profileName)
    const manifestPath = join(profileDir, 'package.json')
    if (args[0] === 'plugin') {
      const action = args[3]
      if (!await exists(manifestPath)) {
        await mkdir(profileDir, { recursive: true })
        await writeFile(manifestPath, JSON.stringify({
          name: `dsh-profile-${profileName}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        }, null, 2) + '\n')
        await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
        await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
      }
      if (action === 'install') return { code: 0, stdout: '', stderr: '' }
      if (action !== 'add') return { code: 2, stdout: '', stderr: `unsupported ${action}` }
      const source = args[4]
      const candidates = {
        'dsh-mnemon@0.1.6': ['dsh-mnemon', '0.1.6'],
        'dsh-openwolf@0.9.1': ['dsh-openwolf', '0.9.1'],
      }
      const selected = candidates[source]
      if (selected === undefined) return { code: 2, stdout: '', stderr: 'unexpected source' }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.dependencies[selected[0]] = selected[1]
      manifest.dsh.profile.bundles.push(selected[0])
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      return { code: 0, stdout: '', stderr: '' }
    }
    await readFile(manifestPath, 'utf8')
    return { code: 0, stdout: '[]', stderr: '' }
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'flow-hub-flow-transaction-'))
  return { home, plan: await fixturePlan(), run: fakeFlowDsh(home) }
}

function options(fixture, extra = {}) {
  return {
    home: fixture.home, dshCli: 'unused', now: () => fixedNow, run: fixture.run,
    minimumFreeBytes: 0, runtimePlatform: 'linux', dshVersion: '0.1.0-rc.6', networkProbe: async () => true,
    bootSmoke: async profile => {
      await readFile(join(fixture.home, 'profiles', profile, 'package.json'), 'utf8')
      return { code: 0, stdout: 'healthy', stderr: '' }
    },
    ...extra,
  }
}

test('Flow transaction creates one isolated headless Profile and writes the deterministic Stack lock', async () => {
  const fx = await fixture()
  try {
    const result = await executeFlowInstallPlan(fx.plan, options(fx))
    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map(item => item.step), fx.plan.steps)
    const profileDir = join(fx.home, 'profiles', fx.plan.profile.name)
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    assert.deepEqual(manifest.dependencies, { 'dsh-mnemon': '0.1.6', 'dsh-openwolf': '0.9.1' })
    const lock = JSON.parse(await readFile(join(profileDir, 'coding-expert.stack.lock.json'), 'utf8'))
    assert.deepEqual(lock, fx.plan.stack)
    const snapshot = JSON.parse(await readFile(join(fx.home, 'flow-hub', 'flow-snapshots', fx.plan.id, 'original.json'), 'utf8'))
    assert.deepEqual(snapshot, { profile: fx.plan.profile.name, existed: false })
  } finally {
    await rm(fx.home, { recursive: true, force: true })
  }
})

test('Flow transaction failure injection at every stage leaves no target Profile', async () => {
  const plan = await fixturePlan()
  for (const step of plan.steps) {
    const fx = await fixture()
    try {
      const result = await executeFlowInstallPlan(fx.plan, options(fx, { failAt: step }))
      assert.equal(result.ok, false, `${step} unexpectedly succeeded`)
      assert.equal(result.steps.find(item => item.step === 'rollback')?.status, 'passed', `${step} rollback failed`)
      assert.equal(await exists(join(fx.home, 'profiles', fx.plan.profile.name)), false, `${step} left target Profile`)
    } finally {
      await rm(fx.home, { recursive: true, force: true })
    }
  }
})

test('Flow transaction refuses blocked plans and existing targets before package installation', async () => {
  const fx = await fixture()
  try {
    let calls = 0
    const blocked = { ...fx.plan, executable: false, blockers: ['registry-signature-not-verified'] }
    const rejected = await executeFlowInstallPlan(blocked, options(fx, { run: async args => { calls += 1; return fx.run(args) } }))
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /flow-plan-not-executable/)
    assert.equal(calls, 0)

    const target = join(fx.home, 'profiles', fx.plan.profile.name)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'sentinel.txt'), 'keep')
    const existing = await executeFlowInstallPlan(fx.plan, options(fx))
    assert.equal(existing.ok, false)
    assert.match(existing.error, /flow-target-profile-already-exists/)
    assert.equal(await readFile(join(target, 'sentinel.txt'), 'utf8'), 'keep')
  } finally {
    await rm(fx.home, { recursive: true, force: true })
  }
})

test('Flow transaction persists credential names but never credential values', async () => {
  const fx = await fixture()
  const previous = process.env.FLOW_TOKEN
  try {
    fx.plan = { ...fx.plan, risk: { ...fx.plan.risk, credentials: ['FLOW_TOKEN'] } }
    const secretValue = 'never-write-this-secret-value'
    process.env.FLOW_TOKEN = secretValue
    const result = await executeFlowInstallPlan(fx.plan, options(fx, { availableCredentials: ['FLOW_TOKEN'] }))
    assert.equal(result.ok, true)
    const files = []
    async function collect(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await collect(path)
        else files.push(path)
      }
    }
    await collect(fx.home)
    const persisted = (await Promise.all(files.map(path => readFile(path, 'utf8').catch(() => '')))).join('\n')
    assert.doesNotMatch(persisted, new RegExp(secretValue))
    assert.match(persisted, /FLOW_TOKEN/)
  } finally {
    if (previous === undefined) delete process.env.FLOW_TOKEN
    else process.env.FLOW_TOKEN = previous
    await rm(fx.home, { recursive: true, force: true })
  }
})

test('startup recovery removes a renamed Flow Profile even when the journal still says staged', async () => {
  const fx = await fixture()
  try {
    const installed = await executeFlowInstallPlan(fx.plan, options(fx))
    assert.equal(installed.ok, true)
    const journalPath = join(fx.home, 'flow-hub', 'flow-transactions', `${fx.plan.id}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.status = 'staged'
    journal.pid = 99999999
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + '\n')
    const recovered = await recoverInterruptedFlowTransactions({ home: fx.home, now: () => fixedNow, isProcessAlive: () => false })
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].steps[0].status, 'passed')
    assert.equal(await exists(join(fx.home, 'profiles', fx.plan.profile.name)), false)
  } finally {
    await rm(fx.home, { recursive: true, force: true })
  }
})
