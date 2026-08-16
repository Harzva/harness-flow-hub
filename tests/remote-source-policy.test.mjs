import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('published Plugin Record rejects a floating GitHub branch even when a commit field is present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-hub-floating-registry-'))
  try {
    const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
    const plugin = registry.plugins.find(item => item.source.kind === 'github-sha')
    plugin.source.spec = plugin.source.spec.replace(/#[a-f0-9]{40}$/, '#main')
    const target = join(root, 'invalid.json')
    await writeFile(target, JSON.stringify(registry), 'utf8')
    const result = spawnSync(process.execPath, ['scripts/validate-registry.mjs', target], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /pattern/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native and public UIs disclose exact pinning and explicitly block floating sources', async () => {
  const [nativeClient, publicClient, workflow] = await Promise.all([
    readFile('src/client/index.tsx', 'utf8'),
    readFile('site/app.js', 'utf8'),
    readFile('.github/workflows/registry.yml', 'utf8'),
  ])
  for (const source of [nativeClient, publicClient]) {
    assert.match(source, /固定 commit/)
    assert.match(source, /精确 npm 版本/)
    assert.match(source, /浮动来源，禁止安装/)
  }
  assert.match(workflow, /registry:verify-source-policy/)
  assert.match(workflow, /m2-remote-source-pinning-2026-08-17\.json/)
})
