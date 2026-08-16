import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const windowsPath = resolve(process.argv[2] ?? 'work/ci-runtime/windows/win32/m3-flow-dependency-runtime-win32-2026-08-17.json')
const linuxPath = resolve(process.argv[3] ?? 'work/ci-runtime/linux/linux/m3-flow-dependency-runtime-linux-2026-08-17.json')
const output = resolve(process.argv[4] ?? 'evidence/m3-flow-dependency-runtime-cross-platform-2026-08-17.json')
const runUrl = process.argv[5] ?? 'https://github.com/Harzva/harness-flow-hub/actions/runs/31970741517'

function requireTrue(value, message) {
  if (!value) throw new Error(message)
}

const inputs = [JSON.parse(await readFile(windowsPath, 'utf8')), JSON.parse(await readFile(linuxPath, 'utf8'))]
const expected = ['dsh-frontend-tools-bridge@0.2.0', 'dsh-mnemon@0.1.6', 'dsh-plugin-writing-guard@0.9.2', 'dsh-science-workbench@0.1.1', 'dsh-vision-router@1.3.0']
const platforms = {}
for (const input of inputs) {
  requireTrue(input.result === 'passed', `platform runtime failed:${input.environment?.os ?? 'unknown'}`)
  requireTrue(input.environment?.dsh === '0.1.0-rc.6', 'DSH version drift')
  requireTrue(input.environment?.runner === 'github-hosted-ephemeral', 'runner isolation drift')
  requireTrue(input.isolation?.freshDshHomePerCandidate === true, 'fresh DSH_HOME missing')
  requireTrue(input.isolation?.lifecycleScriptsDisabled === true, 'lifecycle scripts not disabled')
  requireTrue(input.isolation?.childEnvironmentAllowlisted === true, 'child environment not allowlisted')
  requireTrue(input.isolation?.repositorySecretsForwarded === false, 'repository secrets forwarded')
  requireTrue(input.isolation?.credentialsConfigured === false && input.isolation?.userContentUsed === false, 'credentials or user content entered runtime')
  requireTrue(input.isolation?.outboundNetworkBlocked === false, 'network boundary must be disclosed accurately')
  const subjects = input.records.map(record => `${record.package}@${record.version}`).sort()
  requireTrue(JSON.stringify(subjects) === JSON.stringify(expected), `candidate set drift:${input.environment.os}`)
  for (const record of input.records) {
    requireTrue(record.state === 'passed', `candidate runtime failed:${input.environment.os}:${record.package}`)
    const passedChecks = new Set(record.checks.filter(check => check.status === 'passed').map(check => check.id))
    for (const check of ['profile-bootstrap', 'package-install', 'lock-integrity', 'dump-config', 'plugin-boot', 'bounded-health-probe', 'package-remove', 'post-remove-profile-health']) {
      requireTrue(passedChecks.has(check), `missing check:${input.environment.os}:${record.package}:${check}`)
    }
  }
  platforms[input.environment.os] = {
    status: 'passed',
    environment: input.environment,
    isolation: input.isolation,
    packages: input.records.map(record => ({ package: record.package, version: record.version, state: record.state, probe: record.checks.find(check => check.id === 'bounded-health-probe')?.detail })),
  }
}
requireTrue(platforms.win32 !== undefined && platforms.linux !== undefined, 'Windows and Linux evidence are both required')

const report = {
  schemaVersion: 1,
  verifiedAt: inputs.map(input => input.verifiedAt).sort().at(-1),
  subject: 'Cross-platform bounded runtime verification for five exact initial Flow dependencies',
  baseCommit: '22b0ca35d1753a1d489223530c85fc860de1034e',
  run: runUrl,
  platforms,
  checks: {
    exactPackages: expected,
    windowsPassed: true,
    linuxPassed: true,
    freshProfiles: true,
    installScriptsDisabled: true,
    secretsForwarded: false,
    credentialsConfigured: false,
    userContentUsed: false,
    completeFlowWorkflowExecuted: false,
    securityCertificationClaimed: false,
  },
  registryDecision: {
    verificationStateChanged: false,
    reason: 'Bounded boot evidence does not prove the advertised Coding, Research, or UI Design workflow and does not close the static Flow capability-fit gate.',
  },
  result: 'passed-with-scope-limit',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, platforms: Object.keys(platforms).sort(), packages: expected.length, verificationStateChanged: false })}\n`)
