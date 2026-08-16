import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { assembleHubRelease, validateHubRelease, validateHubReleaseSource } from '../scripts/hub-release-lib.mjs'

test('Hub package, compatibility matrix and release declaration cannot drift', async () => {
  const packageManifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const matrix = JSON.parse(await readFile(resolve('compatibility/dsh-matrix.json'), 'utf8'))
  for (const keyword of ['dsh', 'dsh-plugin', 'dsh-flow', 'dsh-flow-hub', 'dsh-hub', 'deepseek-harness']) {
    assert(packageManifest.keywords.includes(keyword), `missing DSH discovery keyword: ${keyword}`)
  }
  const source = validateHubReleaseSource(packageManifest, matrix)
  assert.equal(packageManifest.version, matrix.hubVersion)
  assert.equal(packageManifest.dsh.compatibility.dsh, matrix.supportedRange)
  assert.deepEqual(source.verifiedVersions, ['0.1.0-rc.6'])

  const wrongRange = structuredClone(packageManifest)
  wrongRange.dsh.compatibility.dsh = '>=0.2.0 <0.3.0'
  assert.throws(() => validateHubReleaseSource(wrongRange, matrix), /dsh-range-mismatch/)
  assert.throws(() => validateHubReleaseSource({ ...packageManifest, version: '0.0.3' }, matrix), /version-matrix-mismatch/)
  const missingMatrix = structuredClone(packageManifest)
  missingMatrix.files = missingMatrix.files.filter(value => value !== 'compatibility\/*.json')
  assert.throws(() => validateHubReleaseSource(missingMatrix, matrix), /omits-compatibility/)
})

test('Hub release candidate is deterministic, self-describing and fails closed for tampering', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'flow-hub-package-release-'))
  try {
    const artifact = join(temp, 'harness-flow-dsh-flow-hub-0.0.2-m0.tgz')
    await writeFile(artifact, 'deterministic-test-package')
    const one = await assembleHubRelease({ artifactPath: artifact, outputDir: join(temp, 'one') })
    const two = await assembleHubRelease({ artifactPath: artifact, outputDir: join(temp, 'two') })
    assert.deepEqual(one.manifest, two.manifest)
    const validated = await validateHubRelease(one.outputDir)
    assert.deepEqual(validated, {
      ok: true,
      packageName: '@harness-flow/dsh-flow-hub',
      version: '0.0.2-m0',
      dshRange: '>=0.1.0-rc.6 <0.2.0',
      verifiedVersions: ['0.1.0-rc.6'],
    })
    const notes = await readFile(join(one.outputDir, 'RELEASE-NOTES.md'), 'utf8')
    assert.match(notes, /Supported DSH: `>=0\.1\.0-rc\.6 <0\.2\.0`/)
    await assert.rejects(validateHubRelease(one.outputDir, { expectedVersion: '0.0.3' }), /tag version mismatch/)
    await writeFile(join(one.outputDir, 'RELEASE-NOTES.md'), 'tampered\n')
    await assert.rejects(validateHubRelease(one.outputDir), /size mismatch|hash mismatch/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('Hub tag workflow publishes only an already validated candidate with DSH range notes', async () => {
  const workflow = parseYaml(await readFile(resolve('.github/workflows/hub-release.yml'), 'utf8'))
  assert.ok(workflow.on.workflow_dispatch !== undefined)
  assert.deepEqual(workflow.on.push.tags, ['hub-v*'])
  assert.equal(workflow.permissions.contents, 'read')
  const candidate = workflow.jobs.candidate
  const metadata = candidate.steps.find(step => step.id === 'metadata')
  assert.match(metadata.run, /-replace '\^hub-v', ''/)
  assert.doesNotMatch(metadata.run, /Substring\(6\)/)
  assert.equal(candidate.steps.find(step => step.run === 'pnpm check').run, 'pnpm check')
  assert.equal(candidate.steps.find(step => step.run === 'pnpm run hub:assemble-release').run, 'pnpm run hub:assemble-release')
  assert.equal(candidate.steps.find(step => step.run === 'pnpm run hub:validate-release').run, 'pnpm run hub:validate-release')
  const upload = candidate.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.match(upload.with.path, /dist\/hub\/\$\{\{ steps\.metadata\.outputs\.version \}\}/)
  const publish = workflow.jobs.publish
  assert.match(publish.if, /refs\/tags\/hub-v/)
  assert.equal(publish.permissions.contents, 'write')
  const release = publish.steps.find(step => step.name === 'Publish Hub package with compatibility declaration')
  assert.match(release.run, /release-candidate\/hub-release\.json/)
  assert.match(release.run, /--notes-file release-candidate\/RELEASE-NOTES\.md/)
  const verification = publish.steps.find(step => step.name === 'Verify published release declares the supported DSH range')
  assert.match(verification.run, /compatibility\.dsh\.supportedRange/)
  assert.match(verification.run, /hub-release\.json/)
})
