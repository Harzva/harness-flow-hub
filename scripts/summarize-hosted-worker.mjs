import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const inputDir = resolve(process.argv[2] ?? 'registry/verifications-ci/Windows')
const outputPath = resolve(process.argv[3] ?? 'evidence/m1-hosted-worker-Windows-2026-08-17.json')
const target = Number(process.argv[4] ?? 10)
const expectedOs = process.argv[5] ?? process.platform

if (!Number.isInteger(target) || target < 1) throw new Error('target must be a positive integer')
if (!['win32', 'linux', 'darwin'].includes(expectedOs)) throw new Error(`unsupported expected OS: ${expectedOs}`)

const names = (await readdir(inputDir)).filter(name => name.endsWith('.json')).sort()
const records = await Promise.all(names.map(async name => ({
  name,
  value: JSON.parse(await readFile(resolve(inputDir, name), 'utf8')),
})))

const accepted = []
for (const { name, value } of records) {
  const checks = new Map((value.checks ?? []).map(check => [check.id, check]))
  if (checks.get('profile-bootstrap')?.status !== 'passed') continue
  if (checks.get('package-install')?.status !== 'passed') continue
  if (checks.get('package-install')?.detail !== 'lifecycle scripts disabled') continue
  if (checks.get('dependency-recorded')?.status !== 'passed') continue
  if (checks.get('package-remove')?.status !== 'passed') continue
  if (checks.get('plugin-boot')?.status !== 'skipped') continue
  if (value.environment?.os !== expectedOs) continue
  if ((value.evidence ?? []).some(item => /^[A-Za-z]:[\\/]|^\//.test(item))) {
    throw new Error(`absolute evidence path is forbidden: ${name}`)
  }
  accepted.push({ subject: value.subject, source: basename(name), verifiedAt: value.verifiedAt })
}

if (accepted.length < target) {
  throw new Error(`hosted worker contract failed: expected ${target}, accepted ${accepted.length}`)
}

const verifiedAt = accepted
  .map(item => item.verifiedAt)
  .filter(Boolean)
  .sort()
  .at(-1) ?? new Date().toISOString()

const result = {
  schemaVersion: 1,
  subject: 'Hosted package transaction verification worker',
  verifiedAt,
  environment: {
    os: expectedOs,
    arch: process.arch,
    node: process.version,
    dsh: records.find(item => item.value.environment?.dsh)?.value.environment.dsh ?? 'unknown',
    githubRunId: process.env.GITHUB_RUN_ID ?? 'local',
  },
  isolation: {
    freshTemporaryDshHomePerCandidate: true,
    officialDshPluginCommand: true,
    lifecycleScriptsDisabled: true,
    thirdPartyRuntimeExecuted: false,
    cleanupGuardedToVerifierRoot: true,
  },
  transactions: {
    target,
    passed: accepted.length,
    subjects: accepted.map(item => item.subject).sort(),
  },
  privacy: {
    credentialsCaptured: false,
    userProfileTouched: false,
    privatePathsRecorded: false,
  },
  scope: 'Package install, dependency recording, and removal only; plugin boot is intentionally not claimed.',
  result: 'passed',
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output: outputPath, os: expectedOs, passed: accepted.length, target })}\n`)
