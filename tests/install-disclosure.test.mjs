import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { resolveFixtureDisclosure } from '../lib/index.js'
import { createInstallPlan } from '../lib/transaction.js'

const fixture = resolve('artifacts/harness-flow-hello-bundle-0.0.2-m2.tgz')

test('trusted fixture disclosure exposes exact version and digest without its private path', async () => {
  const disclosure = resolveFixtureDisclosure(fixture)
  const expected = createHash('sha256').update(await readFile(fixture)).digest('hex')
  assert.deepEqual(disclosure, {
    version: '0.0.2-m2',
    integrity: `sha256:${expected}`,
    lifecycleScripts: [],
  })
  assert.doesNotMatch(JSON.stringify(disclosure), /(?:[A-Z]:\\|\/Users\/|\/home\/)/i)
})

test('install plan schema requires the complete pre-install trust disclosure', async () => {
  const disclosure = resolveFixtureDisclosure(fixture)
  const plan = createInstallPlan({
    action: 'update',
    profile: 'web',
    packageName: '@harness-flow/hello-bundle',
    sourceSpec: fixture,
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
})

test('fixture disclosure fails closed for non-tgz or unversioned packages', () => {
  assert.throws(() => resolveFixtureDisclosure('@harness-flow/hello-bundle@0.0.2-m2'), /fixture-disclosure-requires-tgz/)
  assert.throws(() => resolveFixtureDisclosure('package.tgz'), /fixture-version-not-disclosed/)
})
