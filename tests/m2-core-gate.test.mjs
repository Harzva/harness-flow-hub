import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('M2 core gate combines native UI, Bootstrap, transactions, recovery and offline management', async () => {
  const gate = await readFile('scripts/verify-m2-core-gate.mjs', 'utf8')
  const workflow = await readFile('.github/workflows/registry.yml', 'utf8')
  for (const evidence of [
    'm2-bootstrap-recovery-modes-2026-08-16.json',
    'm2-native-ui-lifecycle-2026-08-16.json',
    'm2-registry-offline-resilience-2026-08-17.json',
    'm2-flow-transaction-lifecycle-2026-08-16.json',
    'm2-formal-source-lifecycle-2026-08-17.json',
    'm2-hub-update-recovery-2026-08-17.json',
  ]) assert.match(gate, new RegExp(evidence.replaceAll('.', '\\.')))
  assert.match(gate, /DSH UI contains an external navigation operation/)
  assert.match(gate, /loopback-and-same-origin-only/)
  assert.match(gate, /transaction phase sequence drift/)
  assert.match(gate, /formal source lifecycle gate failed/)
  assert.match(gate, /incompatible DSH update recovery incomplete/)
  assert.match(gate, /old Hub package, lock or Profile was not restored/)
  assert.match(workflow, /transaction:verify-hub-update-recovery/)
  assert.match(workflow, /pnpm run m2:verify-core/)
  assert.match(workflow, /m2-native-ui-bootstrap-transaction-core-2026-08-17\.json/)
})
