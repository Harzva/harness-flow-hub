import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { probeRegistryUpstream } from '../lib/index.js'

test('Registry availability probe is opt-in, HTTPS-only and fails closed', async () => {
  assert.deepEqual(await probeRegistryUpstream(), { state: 'not-configured', checked: false })
  assert.deepEqual(await probeRegistryUpstream('http://registry.example.test/registry.json'), { state: 'unreachable', checked: true })
  assert.deepEqual(await probeRegistryUpstream('https://user:secret@registry.example.test/registry.json'), { state: 'unreachable', checked: true })
  assert.deepEqual(await probeRegistryUpstream('https://127.0.0.1:9/registry.json'), { state: 'unreachable', checked: true })
})

test('full UI isolates Registry failure from Profiles, tasks and local recovery data', async () => {
  const client = await readFile('src/client/index.tsx', 'utf8')
  const host = await readFile('src/index.ts', 'utf8')
  const patch = await readFile('cordis.patch.yml', 'utf8')
  const workflow = await readFile('.github/workflows/registry.yml', 'utf8')
  assert.match(client, /Promise\.allSettled/)
  assert.match(client, /if \(nextProfiles\.status === 'fulfilled'\) setProfiles/)
  assert.match(client, /if \(nextTasks\.status === 'fulfilled'\) setTasks/)
  assert.match(client, /Registry 当前不可用。/)
  assert.match(client, /已安装 Profiles、恢复点和本地任务仍可管理/)
  assert.match(client, /上游 Registry 不可达，已切换固定本地快照/)
  assert.doesNotMatch(client, /void Promise\.all\(\[/)
  assert.match(host, /catalog: 'bundled-snapshot'/)
  assert.match(host, /offlineReady: true/)
  assert.match(patch, /registryUrl: !!js process\.env\.DSH_FLOW_HUB_REGISTRY_URL/)
  assert.match(workflow, /pnpm run ui:verify-registry-offline/)
  assert.match(workflow, /evidence\/m2-registry-offline-resilience-2026-08-17\.json/)
})
