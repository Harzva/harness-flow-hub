import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

const inputDirectory = resolve(process.argv[2] ?? `evidence-ci/dsh-matrix/${process.platform}`)
const output = resolve(process.argv[3] ?? 'evidence/m2-dsh-version-matrix-2026-08-16.json')
const config = JSON.parse(await readFile(resolve('compatibility/dsh-matrix.json'), 'utf8'))
const files = (await readdir(inputDirectory)).filter(name => name.endsWith('.json')).sort()
const entries = await Promise.all(files.map(async file => JSON.parse(await readFile(join(inputDirectory, file), 'utf8'))))
const byRole = new Map(entries.map(entry => [entry.entry?.role, entry]))
for (const configured of config.entries) {
  const evidence = byRole.get(configured.role)
  if (evidence?.result !== 'passed' || evidence.entry.version !== configured.version || evidence.entry.observed !== configured.expected) {
    throw new Error(`matrix-entry-evidence-mismatch:${configured.role}`)
  }
}
const lifecycle = JSON.parse(await readFile(resolve('evidence/m2-native-ui-lifecycle-2026-08-16.json'), 'utf8'))
if (lifecycle.result !== 'passed' || lifecycle.environment?.dsh !== config.entries.find(entry => entry.role === 'current')?.version) throw new Error('current-lifecycle-evidence-mismatch')
const bootstrap = JSON.parse(await readFile(resolve('evidence/m2-four-dimensional-compatibility-2026-08-16.json'), 'utf8'))
if (bootstrap.checks?.simulatedIncompatible?.aggregate !== config.simulatedIncompatible.expected) throw new Error('simulated-incompatible-evidence-mismatch')

const report = {
  date: new Date().toISOString(),
  subject: 'Published DSH current, previous and RC compatibility matrix',
  governance: {
    config: 'compatibility/dsh-matrix.json',
    workflow: '.github/workflows/dsh-compatibility.yml',
    package: config.package,
    hubVersion: config.hubVersion,
    supportedRange: config.supportedRange,
    observedDistTags: config.observedDistTags,
    nextIsDistinct: config.observedDistTags.next !== config.observedDistTags.latest,
    platforms: config.platforms,
  },
  commands: [
    'pnpm run compatibility:resolve-matrix',
    'pnpm run ui:verify-dsh-version-entry',
    'pnpm run ui:verify-lifecycle',
    'pnpm check',
  ],
  entries: config.entries.map(configured => {
    const evidence = byRole.get(configured.role)
    return { ...configured, environment: evidence.environment, checks: evidence.checks, result: evidence.result }
  }),
  simulatedIncompatible: {
    ...config.simulatedIncompatible,
    checks: bootstrap.checks.simulatedIncompatible,
    hostWriteGate: bootstrap.checks.hostWriteGate,
  },
  currentFullLifecycle: lifecycle.checks,
  policy: {
    verifiedVersionsLoadFullUi: config.entries.filter(entry => entry.expected === 'compatible').map(entry => entry.version),
    rangeCompatibleButUnverifiedState: 'unknown',
    unknownAndIncompatibleAllowMutations: false,
    duplicateNextTagReusesCurrentEntry: config.observedDistTags.next === config.observedDistTags.latest,
  },
  trustBoundary: { userProfileTouched: false, credentialsCaptured: false, browserWriteActionPerformed: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, entries: report.entries.length, result: report.result })}\n`)
