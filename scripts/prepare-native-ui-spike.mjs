import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInstallPlan, executeInstallPlan, listRecoveryPoints } from '../lib/transaction.js'

const configuredHome = process.argv[2]
if (typeof configuredHome !== 'string' || configuredHome.trim() === '') throw new Error('usage: node scripts/prepare-native-ui-spike.mjs <isolated-dsh-home>')
const dshHome = resolve(configuredHome)
const require = createRequire(import.meta.url)
const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
const dshCli = resolve(dirname(packagePath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh)

const operations = [
  { packageName: '@harness-flow/dsh-flow-hub', sourceSpec: resolve('artifacts/harness-flow-dsh-flow-hub-0.0.2-m0.tgz') },
  { packageName: '@harness-flow/hello-bundle', sourceSpec: resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz') },
]
const results = []
for (const operation of operations) {
  const plan = createInstallPlan({
    action: 'update', profile: 'web', packageName: operation.packageName, sourceSpec: operation.sourceSpec,
    verification: 'trusted-fixture', signature: 'not-applicable-trusted-fixture',
  })
  const result = await executeInstallPlan(plan, { home: dshHome, dshCli, dshVersion: pkg.version })
  if (!result.ok) throw new Error(`${operation.packageName} fixture update failed: ${result.error ?? 'unknown'}`)
  results.push({ packageName: operation.packageName, planId: result.planId, phases: result.phases.map(item => item.phase) })
}
const recoveryPoints = await listRecoveryPoints({ home: dshHome, profile: 'web' })
process.stdout.write(`${JSON.stringify({ ok: true, dshVersion: pkg.version, operations: results, recoveryPointCount: recoveryPoints.length })}\n`)
