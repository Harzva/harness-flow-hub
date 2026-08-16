import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const windowsPath = resolve(process.argv[2] ?? 'work/ci-empty/windows/m3-flow-empty-environment-win32-2026-08-17.json')
const linuxPath = resolve(process.argv[3] ?? 'work/ci-empty/linux/m3-flow-empty-environment-linux-2026-08-17.json')
const output = resolve(process.argv[4] ?? 'evidence/m3-flow-empty-environment-cross-platform-2026-08-17.json')
const runUrl = process.argv[5] ?? 'https://github.com/Harzva/harness-flow-hub/actions/runs/31978376581'
const baseCommit = process.argv[6] ?? '75aef03434f8e73463dfdab6d9c1e59ed8b06358'

const expectedFlows = new Map([
  ['coding-expert', { category: 'task-expert', template: 'headless', packages: ['dsh-openwolf@0.9.1'] }],
  ['research-expert', { category: 'domain-expert', template: 'headless', packages: ['dsh-plugin-writing-guard@0.9.2', 'dsh-science-workbench@0.1.1'] }],
  ['ui-design-studio', { category: 'work-environment', template: 'web', packages: ['@anionex/dsh-vision-toolkit@0.1.8'] }],
])
const expectedSteps = ['preflight', 'initialize-profile', 'snapshot', 'staging', 'install-packages', 'dump-config', 'boot-smoke', 'commit', 'health', 'write-stack-lock']

function requireTrue(value, message) {
  if (!value) throw new Error(message)
}

const inputs = await Promise.all([windowsPath, linuxPath].map(async path => JSON.parse(await readFile(path, 'utf8'))))
const platforms = {}
const deterministicStacks = new Map()
for (const input of inputs) {
  const os = input.environment?.os
  requireTrue(os === 'win32' || os === 'linux', 'unexpected empty-environment platform')
  requireTrue(platforms[os] === undefined, `duplicate ${os} empty-environment evidence`)
  requireTrue(input.result === 'passed', `${os} empty-environment Flow verification failed`)
  requireTrue(input.environment?.runner === 'github-hosted-ephemeral' && input.environment?.dsh === '0.1.0-rc.6', `${os} runtime identity drifted`)
  requireTrue(input.registryTrust?.kind === 'ephemeral-test-signature' && input.registryTrust?.status === 'verified', `${os} test Registry signature was not verified`)
  requireTrue(input.registryTrust?.privateKeyPersisted === false && input.registryTrust?.publicRegistryStateChanged === false, `${os} test Registry trust boundary failed`)
  requireTrue(input.isolation?.freshDshHomePerFlow === true && input.isolation?.childEnvironmentAllowlisted === true, `${os} did not isolate every Flow`)
  requireTrue(input.isolation?.repositorySecretsForwarded === false && input.isolation?.userContentUsed === false && input.isolation?.privatePathsRecorded === false, `${os} privacy boundary failed`)
  requireTrue(Array.isArray(input.flows) && input.flows.length === expectedFlows.size, `${os} must contain exactly three launch Flows`)

  const flows = {}
  for (const flow of input.flows) {
    const expected = expectedFlows.get(flow.id)
    requireTrue(expected !== undefined && flows[flow.id] === undefined, `${os} Flow set drifted`)
    requireTrue(flow.category === expected.category && flow.variant === 'safe' && flow.profileTemplate === expected.template, `${os} ${flow.id} identity drifted`)
    requireTrue(flow.freshDshHome === true && flow.signedRegistryGate === 'verified' && flow.planExecutable === true && flow.blockers?.length === 0, `${os} ${flow.id} plan was not executable`)
    requireTrue(flow.officialDumpConfig === 'passed' && flow.stagedAndFinalProfileBoot === 'passed', `${os} ${flow.id} Profile health failed`)
    requireTrue(flow.transactionSteps?.length === expectedSteps.length && flow.transactionSteps.every((step, index) => step.step === expectedSteps[index] && step.status === 'passed'), `${os} ${flow.id} transaction was incomplete`)
    requireTrue(flow.validationTasks?.length >= 3 && flow.validationTasks.every(task => task.status === 'passed' && typeof task.evidence === 'string' && task.evidence !== ''), `${os} ${flow.id} Stack validation was incomplete`)
    requireTrue(flow.capability?.state === 'passed' && flow.capability?.installedByFlowTransaction === true && flow.capability?.userContentUsed === false, `${os} ${flow.id} capability workflow failed`)
    const packages = flow.packages.map(item => `${item.package}@${item.version}`).sort()
    requireTrue(JSON.stringify(packages) === JSON.stringify([...expected.packages].sort()), `${os} ${flow.id} package set drifted`)
    requireTrue(flow.packages.every(item => item.sourceKind === 'npm' && item.integrityRecorded === true && item.lifecycleScriptsDisabled === true), `${os} ${flow.id} package trust metadata failed`)
    requireTrue(/^sha256:[0-9a-f]{64}$/.test(flow.stackLock?.flowDigest ?? '') && /^sha256:[0-9a-f]{64}$/.test(flow.stackLock?.configDigest ?? ''), `${os} ${flow.id} Stack digests are invalid`)
    requireTrue(flow.stackLock.packageCount === packages.length, `${os} ${flow.id} Stack package count drifted`)
    const stackIdentity = `${flow.stackLock.flowDigest}:${flow.stackLock.configDigest}:${flow.stackLock.packageCount}`
    if (deterministicStacks.has(flow.id)) requireTrue(deterministicStacks.get(flow.id) === stackIdentity, `${flow.id} Stack changed across platforms`)
    else deterministicStacks.set(flow.id, stackIdentity)
    flows[flow.id] = {
      status: 'passed', category: flow.category, variant: flow.variant, profileTemplate: flow.profileTemplate,
      packages, transactionSteps: expectedSteps, validationTasks: flow.validationTasks.map(task => task.id),
      capabilityPackage: `${flow.capability.package}@${flow.capability.version}`,
      stackLock: flow.stackLock,
    }
  }
  requireTrue([...expectedFlows.keys()].every(id => flows[id] !== undefined), `${os} is missing a launch Flow`)
  requireTrue(input.decision?.publicRegistryVerificationStateChanged === false && input.decision?.flowExecutableStateChanged === false, `${os} changed public release state from test evidence`)
  platforms[os] = { status: 'passed', node: input.environment.node, dsh: input.environment.dsh, flows }
}
requireTrue(platforms.win32 !== undefined && platforms.linux !== undefined, 'Windows and Linux evidence are both required')

const report = {
  schemaVersion: 1,
  verifiedAt: inputs.map(input => input.verifiedAt).sort().at(-1),
  subject: 'Cross-platform signed test Registry installation of three launch Harness Flows from empty environments',
  baseCommit,
  run: runUrl,
  platforms,
  isolation: {
    registryTrust: 'ephemeral-test-signature-verified', privateKeyPersisted: false,
    freshDshHomePerFlow: true, lifecycleScriptsDisabled: true, childEnvironmentAllowlisted: true,
    repositorySecretsForwarded: false, userContentUsed: false, privatePathsRecorded: false,
  },
  decision: {
    hostedEmptyEnvironmentGate: 'passed-cross-platform',
    publicRegistryVerificationStateChanged: false,
    flowExecutableStateChanged: false,
    publicM3ExitGate: 'open',
    reason: 'All three Safe variants passed signed test-plan compilation, transaction install, DSH Profile boot, Stack validation, and capability smoke on Windows and Linux. Public Registry candidates remain unverified, so public Flow plans remain fail-closed.',
  },
}

const serialized = `${JSON.stringify(report, null, 2)}\n`
requireTrue(!/[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users|tmp)\//.test(serialized), 'aggregate evidence contains a private path')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, serialized, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, platforms: Object.keys(platforms).length, flows: expectedFlows.size, publicM3ExitGate: 'open' })}\n`)
