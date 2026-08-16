import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const output = resolve(process.argv[2] ?? 'evidence/m2-native-ui-bootstrap-transaction-core-2026-08-17.json')
const json = async path => JSON.parse(await readFile(resolve(path), 'utf8'))
const requireTrue = (condition, message) => { if (!condition) throw new Error(message) }
const passed = value => value?.status === 'passed'

const [pkg, client, bootstrapSource, patch, bootstrap, lifecycle, offline, flow, formalSources] = await Promise.all([
  json('package.json'),
  readFile(resolve('src/client/index.tsx'), 'utf8'),
  readFile(resolve('src/client/bootstrap.tsx'), 'utf8'),
  readFile(resolve('cordis.patch.yml'), 'utf8'),
  json('evidence/m2-bootstrap-recovery-modes-2026-08-16.json'),
  json('evidence/m2-native-ui-lifecycle-2026-08-16.json'),
  json('evidence/m2-registry-offline-resilience-2026-08-17.json'),
  json('evidence/m2-flow-transaction-lifecycle-2026-08-16.json'),
  json('evidence/m2-formal-source-lifecycle-2026-08-17.json'),
])

requireTrue(pkg.dsh?.bundle?.patch === './cordis.patch.yml' && pkg.dsh?.client?.platform === 'web' && pkg.exports?.['./client']?.default === './lib/client.js', 'official DSH bundle/client contract missing')
requireTrue(patch.includes("name: '@harness-flow/dsh-flow-hub'") && patch.includes('inject: [webServer]'), 'official DSH Host patch missing')
for (const view of ['home', 'plugins', 'flows', 'profiles', 'tasks']) requireTrue(client.includes(`id: '${view}'`), `native UI view missing:${view}`)
requireTrue(!/(?:window\.open|location\.(?:assign|replace)|<a\s)/i.test(`${client}\n${bootstrapSource}`), 'DSH UI contains an external navigation operation')
requireTrue(client.includes("fetch('/flow-hub/api/plan'") && client.includes("fetch(`/flow-hub/api/${plan.action"), 'same-origin transaction calls missing')
requireTrue(bootstrapSource.includes("fetch('/flow-hub/api/bootstrap'") && bootstrapSource.includes('if (runtime.loadFullUi && bootstrap !== null)'), 'Bootstrap/full UI layering missing')
requireTrue(bootstrap.result === 'passed' && passed(bootstrap.checks.current) && passed(bootstrap.checks.simulatedUnknown) && passed(bootstrap.checks.simulatedIncompatible), 'Bootstrap compatibility modes incomplete')
requireTrue(bootstrap.checks.unknownWriteGate?.http === 409 && bootstrap.checks.hostWriteGate?.http === 409, 'Bootstrap write gates incomplete')
requireTrue(lifecycle.result === 'passed', 'native UI lifecycle failed')
for (const name of ['bootstrap', 'update', 'remove', 'rollback', 'injectedFailure', 'byteForByteRecovery', 'postFailureDumpConfig', 'cliRescue']) requireTrue(passed(lifecycle.checks[name]), `native lifecycle check failed:${name}`)
const requiredPhases = ['preflight', 'snapshot', 'staging', 'install', 'dump-config', 'commit', 'relink', 'health', 'complete']
requireTrue(JSON.stringify(lifecycle.checks.update.phases) === JSON.stringify(requiredPhases), 'transaction phase sequence drift')
requireTrue(lifecycle.checks.injectedFailure.http === 502 && lifecycle.checks.injectedFailure.rollback === 'passed', 'failure rollback contract missing')
requireTrue(lifecycle.trustBoundary?.writeOrigin === 'loopback-and-same-origin-only', 'local write origin boundary missing')
requireTrue(offline.result === 'passed' && offline.checks.upstreamRegistry?.status === 'unreachable' && passed(offline.checks.installedProfileInventory), 'offline local management gate failed')
requireTrue(offline.privacy?.privatePathsRecorded === false && offline.privacy?.credentialsCaptured === false, 'offline evidence privacy boundary failed')
requireTrue(flow.officialDumpConfig === 'passed' && flow.stagedAndFinalBootSmoke === 'HTTP 200' && flow.steps?.every(step => step.status === 'passed'), 'aggregate transaction smoke gate failed')
requireTrue(formalSources.result === 'passed' && JSON.stringify(formalSources.lifecycle) === JSON.stringify(['install', 'update', 'update-rollback', 'health-failure-rollback', 'uninstall', 'uninstall-rollback']), 'formal source lifecycle gate failed')
for (const kind of ['npm', 'tgz']) {
  const adapter = formalSources.adapters?.find(item => item.kind === kind)
  requireTrue(adapter?.install?.status === 'passed' && adapter?.update?.status === 'passed' && adapter?.updateRollback?.status === 'passed', `${kind} install/update/rollback incomplete`)
  requireTrue(adapter?.injectedFailure?.byteForByte === true && adapter?.uninstall?.status === 'passed' && adapter?.uninstallRollback?.status === 'passed', `${kind} failure/uninstall recovery incomplete`)
}
requireTrue(formalSources.trustBoundary?.userProfileTouched === false && formalSources.trustBoundary?.credentialsCaptured === false && formalSources.trustBoundary?.privatePathsRecorded === false, 'formal source evidence privacy boundary failed')

const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  subject: 'M2 native DSH UI, layered Bootstrap and transaction installer release gate',
  environment: { os: process.platform, arch: process.arch, node: process.version, dsh: lifecycle.environment.dsh },
  commands: ['pnpm check', 'pnpm run ui:verify-bootstrap-compatibility', 'pnpm run ui:verify-lifecycle', 'pnpm run ui:verify-registry-offline', 'pnpm run transaction:verify-flow', 'pnpm run transaction:verify-formal-sources', 'pnpm run m2:verify-core'],
  components: {
    nativeUi: { status: 'passed', officialBundleAndClient: true, views: ['home', 'plugins', 'flows', 'profiles', 'tasks'], sameOriginTransactions: true, externalNavigation: false },
    bootstrap: { status: 'passed', modes: ['compatible', 'read-only', 'safe-recovery'], incompatibleWriteHttp: 409 },
    transactionInstaller: { status: 'passed', phases: requiredPhases, update: 200, remove: 200, rollback: 200, injectedFailure: 502, recovery: 'byte-for-byte', finalDumpConfig: 0 },
    offlineLocalManagement: { status: 'passed', upstreamRegistry: 'unreachable', profileAvailable: true },
    flowTransaction: { status: 'passed', isolatedProfile: true, stackLock: true, bootSmoke: 'HTTP 200' },
    formalSources: { status: 'passed', adapters: ['npm', 'tgz'], lifecycle: formalSources.lifecycle, failureRecovery: 'byte-for-byte' },
  },
  privacy: { userProfileTouched: false, credentialsCaptured: false, privatePathsRecorded: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, components: Object.keys(report.components).length })}\n`)
