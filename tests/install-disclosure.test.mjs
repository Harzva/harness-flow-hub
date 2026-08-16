import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { resolveFixtureDisclosure } from '../lib/index.js'
import { createInstallPlan } from '../lib/transaction.js'

async function fixtureArchive() {
  const root = await mkdtemp(join(tmpdir(), 'flow-hub-disclosure-'))
  const fixture = join(root, 'harness-flow-hello-bundle-0.0.2-m2.tgz')
  const bytes = Buffer.from('project-owned-trusted-fixture')
  await writeFile(fixture, bytes)
  return { root, fixture, bytes }
}

test('trusted fixture disclosure exposes exact version and digest without its private path', async () => {
  const fixture = await fixtureArchive()
  try {
    const disclosure = resolveFixtureDisclosure(fixture.fixture)
    const expected = createHash('sha256').update(fixture.bytes).digest('hex')
    assert.deepEqual(disclosure, {
      version: '0.0.2-m2',
      integrity: `sha256:${expected}`,
      lifecycleScripts: [],
    })
    assert.doesNotMatch(JSON.stringify(disclosure), /(?:[A-Z]:\\|\/Users\/|\/home\/)/i)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('install plan schema requires the complete pre-install trust disclosure', async () => {
  const fixture = await fixtureArchive()
  try {
    const disclosure = resolveFixtureDisclosure(fixture.fixture)
    const plan = createInstallPlan({
      action: 'update',
      profile: 'web',
      packageName: '@harness-flow/hello-bundle',
      sourceSpec: fixture.fixture,
      ...disclosure,
      permissions: [],
      credentials: [],
      verification: 'trusted-fixture',
      signature: 'not-applicable-trusted-fixture',
    })
    const ajv = new Ajv2020({ allErrors: true })
    addFormats(ajv)
    const schema = JSON.parse(await readFile(resolve('schemas/install-plan.schema.json'), 'utf8'))
    const validate = ajv.compile(schema)
    assert.equal(validate(plan), true, ajv.errorsText(validate.errors))
    assert.equal(plan.risk.lifecycleScriptsDisabled, true)
    assert.equal(plan.artifact.integrity, disclosure.integrity)
    assert.doesNotMatch(JSON.stringify({ ...plan, source: { ...plan.source, spec: 'configured-tgz' } }), /(?:[A-Z]:\\|\/Users\/|\/home\/)/i)

    const incomplete = structuredClone(plan)
    delete incomplete.artifact
    assert.equal(validate(incomplete), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('fixture disclosure fails closed for non-tgz or unversioned packages', () => {
  assert.throws(() => resolveFixtureDisclosure('@harness-flow/hello-bundle@0.0.2-m2'), /fixture-disclosure-requires-tgz/)
  assert.throws(() => resolveFixtureDisclosure('package.tgz'), /fixture-version-not-disclosed/)
})
