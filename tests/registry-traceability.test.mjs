import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('runtime verification records carry time, full environment, DSH version and immutable public evidence', async () => {
  const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
  const tag = `registry-v${registry.registryVersion}`
  const records = registry.plugins.filter(plugin => plugin.verification?.verifiedAt)
  assert.ok(records.length >= 10)
  for (const plugin of records) {
    assert.match(plugin.verification.verifiedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(plugin.verification.dshVersion, /^\d+\.\d+\.\d+/)
    assert.ok(['win32', 'linux', 'darwin'].includes(plugin.verification.environment.os))
    assert.ok(plugin.verification.environment.arch)
    assert.match(plugin.verification.environment.node, /^v\d+/)
    assert.ok(plugin.verification.evidence.includes(`registry/verifications/${plugin.id}.json`))
    assert.ok(plugin.verification.evidence.includes(`https://github.com/Harzva/harness-flow-hub/blob/${tag}/registry/verifications/${plugin.id}.json`))
  }
})

test('Registry schema rejects a runtime claim with missing environment or public evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-hub-traceability-'))
  try {
    const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
    const plugin = registry.plugins.find(item => item.verification?.verifiedAt)
    delete plugin.verification.environment
    plugin.verification.evidence = ['registry/verifications/local-only.json']
    const target = join(root, 'invalid.json')
    await writeFile(target, JSON.stringify(registry), 'utf8')
    const result = spawnSync(process.execPath, ['scripts/validate-registry.mjs', target], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /environment|contains/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('public discovery UI exposes verification time, environment, DSH version and evidence action', async () => {
  const [site, nativeClient, workflow] = await Promise.all([
    readFile('site/app.js', 'utf8'),
    readFile('src/client/index.tsx', 'utf8'),
    readFile('.github/workflows/registry.yml', 'utf8'),
  ])
  for (const source of [site, nativeClient]) {
    assert.match(source, /验证时间/)
    assert.match(source, /environment\.arch/)
    assert.match(source, /DSH 版本/)
  }
  assert.match(site, /查看验证证据/)
  assert.match(nativeClient, /证据链接/)
  assert.match(workflow, /pnpm run registry:verify-traceability/)
  assert.match(workflow, /m2-registry-verification-traceability-2026-08-17\.json/)
})
