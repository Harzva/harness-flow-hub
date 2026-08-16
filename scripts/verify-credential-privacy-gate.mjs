import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { compileStackPreview } from '../lib/flow-resolver.js'
import { credentialNames, telemetryPolicy } from '../lib/privacy.js'
import { createInstallPlan, executeInstallPlan } from '../lib/transaction.js'

const output = resolve(process.argv[2] ?? 'evidence/m2-credential-privacy-gate-2026-08-17.json')
const secret = 'sk-flow-hub-privacy-gate-1234567890'
const credentialName = 'FLOW_PRIVACY_TOKEN'
const registryText = await readFile('registry/generated/registry.json', 'utf8')
assert.ok(!registryText.includes(secret))
assert.throws(() => credentialNames([secret]), /credential-name-required/)

const registry = JSON.parse(registryText)
const flow = parseYaml(await readFile('registry/flows/coding-expert.dsh-flow.yml', 'utf8'))
flow.variants.lite.credentials = [credentialName]
const stack = compileStackPreview(flow, 'lite', registry.plugins, {
  generatedAt: '2026-08-17T00:00:00.000Z', dshVersion: '0.1.0-rc.6', platform: process.platform === 'win32' ? 'win32' : 'linux', arch: process.arch, node: process.version,
})
assert.ok(!JSON.stringify(stack).includes(secret))
assert.ok(!JSON.stringify(stack).includes(credentialName), 'Stack lock persisted a credential identifier instead of only its config digest')

const temp = await mkdtemp(join(tmpdir(), 'flow-hub-credential-privacy-'))
const profileDir = join(temp, 'profiles', 'web')
const previous = process.env[credentialName]
let childReceivedSecret = false
try {
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'privacy-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2) + '\n')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
  process.env[credentialName] = secret
  const plan = createInstallPlan({
    action: 'add', profile: 'web', packageName: '@harness-flow/hello-bundle', sourceSpec: '@harness-flow/hello-bundle@0.0.1',
    credentials: [credentialName], verification: 'passed', signature: 'verified', now: new Date('2026-08-17T00:00:00.000Z'),
  })
  const result = await executeInstallPlan(plan, {
    home: temp, dshCli: 'unused', now: () => new Date('2026-08-17T00:00:00.000Z'), minimumFreeBytes: 0,
    dshVersion: '0.1.0-rc.6', runtimePlatform: process.platform, networkProbe: async () => true,
    run: async (_args, env) => {
      childReceivedSecret ||= env[credentialName] === secret
      return { code: 1, stdout: secret, stderr: secret }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(childReceivedSecret, true, 'credential was not available to the isolated child process')
  assert.ok(!JSON.stringify(result).includes(secret), 'transaction result leaked child output or a credential value')

  const persisted = []
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else persisted.push(await readFile(path, 'utf8').catch(() => ''))
    }
  }
  await collect(temp)
  assert.ok(!persisted.join('\n').includes(secret), 'transaction journal, snapshot or Profile leaked a credential value')
} finally {
  if (previous === undefined) delete process.env[credentialName]
  else process.env[credentialName] = previous
  await rm(temp, { recursive: true, force: true })
}

const sourceFiles = ['src/index.ts', 'src/transaction.ts', 'src/flow-resolver.ts', 'src/privacy.ts']
const source = (await Promise.all(sourceFiles.map(path => readFile(path, 'utf8')))).join('\n')
assert.equal(telemetryPolicy.enabled, false)
assert.deepEqual(telemetryPolicy.persistedCredentialFields, [])
assert.doesNotMatch(source, /sendBeacon|\/telemetry\b|analytics\.(?:track|identify)|posthog\.(?:capture|identify)/i)

const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  subject: 'Credential value isolation across Registry, transaction records, Stack locks and telemetry',
  checks: {
    registrySecretValueAbsent: true,
    credentialDeclarationsNamesOnly: true,
    childEnvironmentAvailable: childReceivedSecret,
    transactionResultRedacted: true,
    journalAndSnapshotSecretValueAbsent: true,
    stackLockCredentialValueAbsent: true,
    stackLockCredentialNameAbsent: true,
    telemetryEnabled: telemetryPolicy.enabled,
    telemetryCredentialFields: telemetryPolicy.persistedCredentialFields,
    telemetrySinkDetected: false,
  },
  boundary: { credentialNamesDisclosedBeforeInstall: true, credentialValuesPersisted: false },
  privacy: { credentialValueRecordedInEvidence: false, privatePathsRecorded: false, userContentCaptured: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, credentialValuesPersisted: false, telemetryEnabled: false })}\n`)
