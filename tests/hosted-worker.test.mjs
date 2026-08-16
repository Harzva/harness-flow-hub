import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function fixture(root, count = 10) {
  const input = join(root, 'input')
  await mkdir(input)
  for (let index = 0; index < count; index += 1) {
    const subject = `fixture-${String(index).padStart(2, '0')}`
    await writeFile(join(input, `${subject}.json`), `${JSON.stringify({
      schemaVersion: 1,
      subject,
      state: 'unverified',
      verifiedAt: `2026-08-17T00:00:${String(index).padStart(2, '0')}.000Z`,
      environment: { os: process.platform, arch: process.arch, node: process.version, dsh: '0.1.0-rc.6' },
      checks: [
        { id: 'profile-bootstrap', status: 'passed' },
        { id: 'package-install', status: 'passed', detail: 'lifecycle scripts disabled' },
        { id: 'dependency-recorded', status: 'passed' },
        { id: 'package-remove', status: 'passed' },
        { id: 'plugin-boot', status: 'skipped', detail: 'not executed' },
      ],
      evidence: [`registry/verifications/${subject}.json`],
    }, null, 2)}\n`, 'utf8')
  }
  return input
}

test('hosted worker summary proves ten isolated package transactions without claiming plugin boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-hub-worker-summary-'))
  try {
    const input = await fixture(root)
    const output = join(root, 'evidence.json')
    const run = spawnSync(process.execPath, ['scripts/summarize-hosted-worker.mjs', input, output, '10'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(evidence.result, 'passed')
    assert.equal(evidence.transactions.passed, 10)
    assert.equal(evidence.isolation.lifecycleScriptsDisabled, true)
    assert.equal(evidence.isolation.thirdPartyRuntimeExecuted, false)
    assert.match(evidence.scope, /plugin boot is intentionally not claimed/)
    assert.deepEqual(evidence.privacy, {
      credentialsCaptured: false,
      userProfileTouched: false,
      privatePathsRecorded: false,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hosted worker summary fails closed when the transaction target is not met', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-hub-worker-summary-fail-'))
  try {
    const input = await fixture(root, 9)
    const output = join(root, 'evidence.json')
    const run = spawnSync(process.execPath, ['scripts/summarize-hosted-worker.mjs', input, output, '10'], { encoding: 'utf8' })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /expected 10, accepted 9/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hosted worker evidence downloaded from another platform remains independently reviewable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-hub-worker-summary-cross-os-'))
  try {
    const input = await fixture(root)
    const names = await import('node:fs/promises').then(fs => fs.readdir(input))
    for (const name of names) {
      const path = join(input, name)
      const record = JSON.parse(await readFile(path, 'utf8'))
      record.environment.os = 'linux'
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    }
    const output = join(root, 'evidence.json')
    const run = spawnSync(process.execPath, ['scripts/summarize-hosted-worker.mjs', input, output, '10', 'linux'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(evidence.environment.os, 'linux')
    assert.equal(evidence.transactions.passed, 10)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
