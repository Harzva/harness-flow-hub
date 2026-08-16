import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { auditCandidateMetadata, entryUrl } from '../scripts/candidate-audit-lib.mjs'
import { signRegistry, verifyRegistrySignature } from '../scripts/registry-signature-lib.mjs'
import { resolveVerificationState, VERIFICATION_STATES } from '../scripts/verification-state-lib.mjs'
import { assembleRegistryRelease, validateRegistryRelease } from '../scripts/registry-release-lib.mjs'
import { parse as parseYaml } from 'yaml'

const input = resolve('registry/discovery/github-topic-2026-08-16.json')

test('candidate metadata audit validates manifest, entry, license, scripts and pinned source', () => {
  const candidate = {
    source: {
      kind: 'github-sha',
      spec: 'github:owner/repo#0123456789abcdef0123456789abcdef01234567',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    repository: 'owner/repo',
    license: 'MIT',
    package: {
      name: '@owner/plugin',
      version: '1.2.3',
      bundlePatch: './cordis.patch.yml',
      scripts: { build: 'tsc' },
    },
  }
  assert.equal(auditCandidateMetadata(candidate).every(item => item.status === 'passed'), true)
  assert.equal(entryUrl(candidate), 'https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/cordis.patch.yml')
  candidate.package.bundlePatch = '../outside.yml'
  assert.equal(auditCandidateMetadata(candidate).find(item => item.id === 'bundle-entry-declared').status, 'failed')
})

test('candidate snapshot has 20 pinned/disclosed records from GitHub and npm', async () => {
  const snapshot = JSON.parse(await readFile(input, 'utf8'))
  assert.equal(snapshot.candidates.length, 20)
  const kinds = new Map()
  for (const candidate of snapshot.candidates) {
    kinds.set(candidate.source.kind, (kinds.get(candidate.source.kind) ?? 0) + 1)
    if (candidate.source.kind === 'github-sha') assert.match(candidate.source.commit, /^[a-f0-9]{40}$/)
    if (candidate.source.kind === 'npm') assert.match(candidate.source.integrity, /^sha512-/)
  }
  assert.ok((kinds.get('github-sha') ?? 0) > 0)
  assert.ok((kinds.get('npm') ?? 0) > 0)
})

test('same discovery input generates byte-identical valid registry', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-registry-'))
  try {
    const one = join(temp, 'one.json')
    const two = join(temp, 'two.json')
    execFileSync(process.execPath, ['scripts/generate-registry.mjs', input, one])
    execFileSync(process.execPath, ['scripts/generate-registry.mjs', input, two])
    assert.deepEqual(await readFile(one), await readFile(two))
    execFileSync(process.execPath, ['scripts/validate-registry.mjs', one])
    const registry = JSON.parse(await readFile(one, 'utf8'))
    assert.equal(registry.flows.length, 1)
    assert.equal(registry.flows[0].id, 'coding-expert')
    assert.deepEqual(registry.flows[0].variants, ['lite', 'safe'])
    assert.match(registry.flows[0].digest, /^sha256:[a-f0-9]{64}$/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('registry source hash is identical for LF and CRLF discovery files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-registry-newlines-'))
  try {
    const source = (await readFile(input, 'utf8')).replaceAll('\r\n', '\n')
    const lfInput = join(temp, 'lf.json')
    const crlfInput = join(temp, 'crlf.json')
    const lfOutput = join(temp, 'lf-registry.json')
    const crlfOutput = join(temp, 'crlf-registry.json')
    await writeFile(lfInput, source, 'utf8')
    await writeFile(crlfInput, source.replaceAll('\n', '\r\n'), 'utf8')
    execFileSync(process.execPath, ['scripts/generate-registry.mjs', lfInput, lfOutput])
    execFileSync(process.execPath, ['scripts/generate-registry.mjs', crlfInput, crlfOutput])
    assert.deepEqual(await readFile(lfOutput), await readFile(crlfOutput))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('invalid verification state is blocked from registry publication', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-invalid-registry-'))
  try {
    const target = join(temp, 'invalid.json')
    const registry = JSON.parse(await readFile(resolve('registry/generated/registry.json'), 'utf8'))
    registry.plugins[0].verification.state = 'trusted'
    await writeFile(target, JSON.stringify(registry), 'utf8')
    const result = spawnSync(process.execPath, ['scripts/validate-registry.mjs', target], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be equal to one of the allowed values/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('prepublication input gate rejects floating sources and private evidence paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-input-gate-'))
  try {
    const discovery = JSON.parse(await readFile(input, 'utf8'))
    const githubCandidate = discovery.candidates.find(candidate => candidate.source.kind === 'github-sha')
    githubCandidate.source.spec = `github:${githubCandidate.repository}#main`
    const badDiscovery = join(temp, 'discovery.json')
    await writeFile(badDiscovery, JSON.stringify(discovery), 'utf8')
    const floating = spawnSync(process.execPath, ['scripts/validate-registry-inputs.mjs', badDiscovery, 'registry/verifications'], { encoding: 'utf8' })
    assert.notEqual(floating.status, 0)
    assert.match(floating.stderr, /not pinned exactly|must match pattern/)

    const verificationDir = join(temp, 'verifications')
    await mkdir(verificationDir)
    const result = JSON.parse(await readFile(resolve('registry/verifications/dsh-any-background.json'), 'utf8'))
    result.evidence = ['C:\\Users\\private\\verification.json']
    await writeFile(join(verificationDir, 'private.json'), JSON.stringify(result), 'utf8')
    const privatePath = spawnSync(process.execPath, ['scripts/validate-registry-inputs.mjs', input, verificationDir], { encoding: 'utf8' })
    assert.notEqual(privatePath.status, 0)
    assert.match(privatePath.stderr, /private-absolute-path|unsafe evidence path/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('verification schema exposes exactly five explicit trust states', async () => {
  const schema = JSON.parse(await readFile(resolve('schemas/verification-result.schema.json'), 'utf8'))
  assert.deepEqual(schema.properties.state.enum, ['unknown', 'unverified', 'passed', 'failed', 'stale'])
})

test('verification states are operational and stale derivation is deterministic', () => {
  assert.deepEqual(VERIFICATION_STATES, ['unknown', 'unverified', 'passed', 'failed', 'stale'])
  assert.equal(resolveVerificationState(undefined, { asOf: '2026-08-16' }), 'unverified')
  assert.equal(resolveVerificationState({ state: 'unknown' }, { asOf: '2026-08-16' }), 'unknown')
  assert.equal(resolveVerificationState({ state: 'failed' }, { asOf: '2026-08-16' }), 'failed')
  assert.equal(resolveVerificationState({ state: 'passed', verifiedAt: '2026-08-10T00:00:00.000Z' }, { asOf: '2026-08-16' }), 'passed')
  assert.equal(resolveVerificationState({ state: 'passed', verifiedAt: '2026-06-01T00:00:00.000Z' }, { asOf: '2026-08-16' }), 'stale')
  assert.throws(() => resolveVerificationState({ state: 'trusted' }, { asOf: '2026-08-16' }), /invalid verification state/)
})

test('platform matrix configures Windows and Linux while disclosing macOS as uncovered', async () => {
  const support = JSON.parse(await readFile(resolve('registry/platform-support.json'), 'utf8'))
  assert.equal(support.platforms.win32.worker, 'implemented')
  assert.equal(support.platforms.linux.worker, 'implemented')
  assert.equal(support.platforms.darwin.worker, 'not-covered')
  assert.match(support.platforms.win32.currentEvidence, /^https:\/\/github\.com\/Harzva\/harness-flow-hub\/actions\/runs\/\d+$/)
  assert.match(support.platforms.linux.currentEvidence, /^https:\/\/github\.com\/Harzva\/harness-flow-hub\/actions\/runs\/\d+$/)
  assert.match(support.platforms.win32.isolation, /third-party runtime not executed/)
  assert.match(support.platforms.linux.isolation, /third-party runtime not executed/)
  assert.equal(support.platforms.darwin.currentEvidence, null)
})

test('detached registry signature fails closed for tampering, expiry and revocation', async () => {
  const registryText = await readFile(resolve('registry/generated/registry.json'), 'utf8')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const envelope = signRegistry(registryText, privateKey, {
    keyId: 'alpha-test-key',
    createdAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2026-08-17T00:00:00.000Z',
  })
  const options = { now: '2026-08-16T12:00:00.000Z', revocations: { revokedKeyIds: [], revokedRegistryVersions: [] } }
  assert.deepEqual(verifyRegistrySignature(registryText, envelope, publicKey, options), { ok: true, reason: 'verified' })
  assert.equal(verifyRegistrySignature(`${registryText} `, envelope, publicKey, options).reason, 'hash-mismatch')
  assert.equal(verifyRegistrySignature(registryText, envelope, publicKey, { ...options, now: '2026-08-18T00:00:00.000Z' }).reason, 'expired')
  assert.equal(verifyRegistrySignature(registryText, { ...envelope, expiresAt: 'invalid' }, publicKey, options).reason, 'invalid-validity-window')
  assert.equal(verifyRegistrySignature(registryText, envelope, publicKey, {
    ...options,
    revocations: { revokedKeyIds: ['alpha-test-key'], revokedRegistryVersions: [] },
  }).reason, 'key-revoked')
})

test('Registry release candidate is deterministic and cannot publish unsigned', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-release-'))
  try {
    const one = await assembleRegistryRelease({ outputDir: join(temp, 'one') })
    const two = await assembleRegistryRelease({ outputDir: join(temp, 'two') })
    assert.deepEqual(one.manifest, two.manifest)
    assert.equal(one.manifest.status, 'candidate')
    assert.equal(one.manifest.signaturePresent, false)
    await assert.doesNotReject(validateRegistryRelease(one.outputDir, { allowUnsigned: true }))
    await assert.rejects(validateRegistryRelease(one.outputDir), /unsigned Registry release is not publishable/)
    await writeFile(join(one.outputDir, 'registry', 'registry.json'), '{}\n', 'utf8')
    await assert.rejects(validateRegistryRelease(one.outputDir, { allowUnsigned: true }), /size mismatch|hash mismatch/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('Registry release becomes publishable only with a valid detached signature', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-signed-release-'))
  try {
    const registryText = await readFile(resolve('registry/generated/registry.json'), 'utf8')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const envelope = signRegistry(registryText, privateKey, {
      keyId: 'alpha-release-test-key',
      createdAt: '2026-08-16T00:00:00.000Z',
      expiresAt: '2026-08-17T00:00:00.000Z',
    })
    const signaturePath = join(temp, 'registry.signature.json')
    const publicKeyPath = join(temp, 'registry-public.pem')
    await writeFile(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
    await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8')
    const release = await assembleRegistryRelease({
      outputDir: join(temp, 'signed'), signaturePath, publicKeyPath, now: '2026-08-16T12:00:00.000Z',
    })
    assert.equal(release.manifest.status, 'signed')
    assert.equal(release.manifest.signaturePresent, true)
    await assert.doesNotReject(validateRegistryRelease(release.outputDir, { now: '2026-08-16T12:00:00.000Z' }))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('hosted worker workflow parses and retains full Windows and Linux evidence on failure', async () => {
  const workflow = parseYaml(await readFile(resolve('.github/workflows/registry.yml'), 'utf8'))
  const workspace = parseYaml(await readFile(resolve('pnpm-workspace.yaml'), 'utf8'))
  const packageManifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  assert.equal(workspace.allowBuilds['node-pty'], true)
  assert.match(packageManifest.scripts['pack:hub'], /^pnpm build && pnpm pack/)
  const job = workflow.jobs['install-transaction']
  assert.deepEqual(job.strategy.matrix.os, ['windows-latest', 'ubuntu-latest'])
  assert.equal(job['timeout-minutes'], 45)
  const verifier = job.steps.find(step => step.name?.startsWith('Verify ten package transactions'))
  assert.match(verifier.run, /registry\/verifications-ci\/\$\{\{ runner\.os \}\} 10$/)
  const summary = job.steps.find(step => step.name === 'Summarize hosted worker isolation evidence')
  assert.match(summary.run, /summarize-hosted-worker\.mjs/)
  assert.match(summary.run, /m1-hosted-worker-\$\{\{ runner\.os \}\}-2026-08-17\.json 10$/)
  const lifecycle = job.steps.find(step => step.name === 'Verify native UI lifecycle and failed-transaction recovery')
  assert.equal(lifecycle.run, 'pnpm run ui:verify-lifecycle')
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(upload.if, 'always()')
  assert.match(upload.with.path, /m1-hosted-worker-\$\{\{ runner\.os \}\}-2026-08-17\.json/)
  assert.match(upload.with.path, /m2-native-ui-lifecycle-2026-08-16\.json/)
})

test('Registry publication workflow defaults to candidate-only and protects the signing job', async () => {
  const workflow = parseYaml(await readFile(resolve('.github/workflows/registry-release.yml'), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false)
  assert.equal(workflow.on.workflow_dispatch.inputs.expires_at.required, true)
  assert.equal(workflow.permissions.contents, 'read')
  const publish = workflow.jobs['sign-and-publish']
  assert.equal(publish.if, 'inputs.publish')
  assert.equal(publish.environment, 'registry-publish')
  assert.equal(publish.permissions.contents, 'write')
  const keyStep = publish.steps.find(step => step.name === 'Materialize protected signing keys')
  assert.match(keyStep.env.PRIVATE_KEY_B64, /secrets\.REGISTRY_ED25519_PRIVATE_KEY_B64/)
  const releaseStep = publish.steps.find(step => step.name === 'Publish immutable GitHub Release asset')
  assert.match(releaseStep.run, /gh release create registry-v2026\.08\.16-alpha\.1/)
  assert.match(releaseStep.run, /--prerelease/)
  const immutableCheck = publish.steps.find(step => step.name === 'Verify published Release is immutable')
  assert.match(immutableCheck.run, /\.immutable/)
})
