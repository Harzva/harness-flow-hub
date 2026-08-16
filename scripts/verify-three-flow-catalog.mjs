import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'
import { compileFlowInstallPlan, compileStackPreview } from '../lib/flow-resolver.js'

const output = process.argv[2]
const requiredCategories = ['domain-expert', 'task-expert', 'work-environment']
const requiredVariants = ['lite', 'standard', 'local', 'safe']
const generatedAt = '2026-08-17T00:00:00.000Z'
const dshVersion = '0.1.0-rc.6'
const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
const schema = JSON.parse(await readFile('schemas/harness-flow.schema.json', 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validate = ajv.compile(schema)
const names = (await readdir('registry/flows')).filter(name => name.endsWith('.dsh-flow.yml')).sort()
const flows = await Promise.all(names.map(async name => ({
  name,
  flow: parseYaml(await readFile(resolve('registry/flows', name), 'utf8')),
})))

assert.equal(flows.length, 3, 'launch catalog must contain exactly three Flow definitions')
assert.deepEqual(flows.map(({ flow }) => flow.category).sort(), requiredCategories)

const profiles = new Set()
const summaries = []
for (const { name, flow } of flows) {
  assert.equal(validate(flow), true, `${name}: ${ajv.errorsText(validate.errors)}`)
  assert.deepEqual(Object.keys(flow.variants).sort(), [...requiredVariants].sort(), `${flow.id} must provide all four variants`)
  assert.ok(flow.validation.some(item => item.kind === 'dump-config'))
  assert.ok(flow.validation.some(item => item.kind === 'profile-boot'))
  assert.ok(flow.validation.some(item => item.kind === 'workflow-smoke'))

  const variants = []
  for (const variantName of requiredVariants) {
    const variant = flow.variants[variantName]
    for (const field of ['boundaries', 'skills', 'plugins', 'memory', 'workflows', 'uiExtensions', 'platforms']) {
      assert.ok(Array.isArray(variant[field]) && variant[field].length > 0, `${flow.id}/${variantName} missing ${field}`)
    }
    assert.equal(variant.defaults.profileIsolation, 'new-profile')
    assert.ok(['headless', 'web'].includes(variant.defaults.profileTemplate))

    const options = {
      generatedAt,
      dshVersion,
      platform: 'linux',
      arch: 'x64',
      node: 'v24.0.0',
      includeRecommended: false,
    }
    const stack = compileStackPreview(flow, variantName, registry.plugins, options)
    const repeated = compileStackPreview(flow, variantName, [...registry.plugins].reverse(), options)
    assert.deepEqual(stack, repeated, `${flow.id}/${variantName} Stack must be deterministic`)
    assert.equal(profiles.has(stack.profile), false, `${stack.profile} must be unique`)
    profiles.add(stack.profile)

    const plan = compileFlowInstallPlan(flow, variantName, registry.plugins, {
      ...options,
      registrySignature: 'verified',
    })
    assert.equal(plan.profile.isolation, 'new')
    assert.equal(plan.profile.name, stack.profile)
    assert.equal(plan.executable, false, 'unverified community dependencies must fail closed')
    assert.ok(plan.blockers.some(item => item.startsWith('plugin-not-verified:')))
    assert.deepEqual(plan.steps, ['preflight', 'initialize-profile', 'snapshot', 'staging', 'install-packages', 'dump-config', 'boot-smoke', 'commit', 'health', 'write-stack-lock'])
    variants.push({
      id: variantName,
      profile: stack.profile,
      profileTemplate: plan.profile.template,
      packages: stack.packages.map(item => `${item.package}@${item.version}`),
      stackDigest: stack.flow.digest,
      configDigest: stack.configDigest,
      executable: plan.executable,
      blockerKinds: [...new Set(plan.blockers.map(item => item.split(':')[0]))].sort(),
    })
  }
  summaries.push({
    id: flow.id,
    category: flow.category,
    manifest: `registry/flows/${name}`,
    variants,
    validationKinds: [...new Set(flow.validation.map(item => item.kind))].sort(),
  })
}

const evidence = {
  schemaVersion: 1,
  asOf: '2026-08-17',
  dshVersion,
  result: 'passed',
  checks: {
    flowCount: flows.length,
    categories: requiredCategories,
    variantsPerFlow: requiredVariants,
    deterministicStackCount: summaries.reduce((total, item) => total + item.variants.length, 0),
    uniqueProfileCount: profiles.size,
    completeSections: true,
    unverifiedDependenciesFailClosed: true,
  },
  officialReuse: [
    'dsh plugin --profile <name> <pnpm args>',
    'dsh.profile.bundles',
    'dsh --dump-config',
    'DSH client modules and UI slots',
  ],
  flows: summaries,
  privacy: { credentialsCaptured: false, userContentCaptured: false, privatePathsRecorded: false },
}

const serialized = `${JSON.stringify(evidence, null, 2)}\n`
assert.doesNotMatch(serialized, /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})/)
if (output !== undefined) {
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(output), serialized, 'utf8')
}
process.stdout.write(serialized)
