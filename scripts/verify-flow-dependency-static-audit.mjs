import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const policyPath = resolve(process.argv[2] ?? 'registry/audits/flow-dependency-policy.json')
const discoveryPath = resolve(process.argv[3] ?? 'registry/discovery/github-topic-2026-08-16.json')
const outputPath = resolve(process.argv[4] ?? 'evidence/m3-flow-dependency-static-audit-2026-08-17.json')
const policy = JSON.parse(await readFile(policyPath, 'utf8'))
const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
const tempRoot = await mkdtemp(join(tmpdir(), 'harness-flow-static-audit-'))

function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function requireTrue(value, message) {
  if (!value) throw new Error(message)
}

try {
  const results = []
  for (const item of policy.packages) {
    const discovered = discovery.candidates.find(candidate => candidate.package?.name === item.package && candidate.package?.version === item.version)
    requireTrue(discovered !== undefined, `pinned candidate missing:${item.package}@${item.version}`)
    requireTrue(discovered.source.kind === 'npm', `candidate is not npm:${item.package}`)
    requireTrue(discovered.source.spec === `${item.package}@${item.version}`, `source is not exact:${item.package}`)
    requireTrue(discovered.source.integrity === item.integrity, `discovery integrity drift:${item.package}`)

    const response = await fetch(item.tarball, { signal: AbortSignal.timeout(30_000) })
    requireTrue(response.ok, `tarball download failed:${item.package}:${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    requireTrue(integrity(bytes) === item.integrity, `tarball integrity failed:${item.package}`)

    const packageRoot = join(tempRoot, `${item.package}-${item.version}`)
    await mkdir(packageRoot, { recursive: true })
    const archivePath = join(packageRoot, 'package.tgz')
    await writeFile(archivePath, bytes)
    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', packageRoot], { encoding: 'utf8', windowsHide: true })
    requireTrue(extracted.status === 0, `tarball extraction failed:${item.package}`)
    const root = join(packageRoot, 'package')
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const patch = await readFile(join(root, item.bundlePatch.replace(/^\.\//, '')), 'utf8')
    const entry = await readFile(join(root, item.entry), 'utf8')
    const sourceFiles = [entry]
    for (const path of item.inspectFiles ?? []) sourceFiles.push(await readFile(join(root, path), 'utf8'))
    const source = sourceFiles.join('\n')

    requireTrue(manifest.name === item.package && manifest.version === item.version, `manifest identity drift:${item.package}`)
    requireTrue(manifest.license === item.license, `license drift:${item.package}`)
    requireTrue(manifest.dsh?.bundle?.patch === item.bundlePatch, `bundle patch drift:${item.package}`)
    requireTrue(patch.includes(`name: ${item.package}`) || patch.includes(`name: '${item.package}'`), `patch does not mount package:${item.package}`)
    for (const needle of item.capabilityEvidence) requireTrue(source.includes(needle), `capability evidence missing:${item.package}:${needle}`)
    for (const needle of item.riskEvidence) requireTrue(source.includes(needle), `risk disclosure evidence missing:${item.package}:${needle}`)
    const lifecycleNames = Object.keys(manifest.scripts ?? {}).sort()
    const installScripts = lifecycleNames.filter(name => ['preinstall', 'install', 'postinstall', 'prepare'].includes(name))
    const allowedInstallLifecycleScripts = [...(item.allowedInstallLifecycleScripts ?? [])].sort()
    requireTrue(JSON.stringify(installScripts) === JSON.stringify(allowedInstallLifecycleScripts), `install lifecycle disclosure drift:${item.package}:${installScripts.join(',')}`)

    results.push({
      package: item.package,
      version: item.version,
      source: `${item.package}@${item.version}`,
      integrity: 'passed',
      manifest: 'passed',
      bundlePatch: 'passed',
      installLifecycleScripts: installScripts,
      installLifecyclePolicy: installScripts.length === 0 ? 'absent' : 'declared-and-disabled-by-hub',
      capabilityEvidence: 'passed',
      riskDisclosureEvidence: 'passed',
      hostedBootEligible: item.hostedBootEligible,
      flowFit: item.flowFit,
    })
  }

  requireTrue(results.length === 7, 'expected seven corrected Flow dependencies')
  requireTrue(Object.values(policy.flowCapabilityGate).every(gate => gate.passed === false), 'static audit must not close a Flow capability gate')
  await mkdir(resolve(outputPath, '..'), { recursive: true })
  const evidence = {
    schemaVersion: 1,
    auditedAt: new Date().toISOString(),
    subject: policy.scope,
    inputs: ['registry/audits/flow-dependency-policy.json', 'registry/discovery/github-topic-2026-08-16.json'],
    checks: {
      exactArtifactsInspected: results.length,
      integrityPassed: results.every(result => result.integrity === 'passed'),
      installLifecycleScriptsAbsentOrDeclaredAndDisabled: results.every(result => ['absent', 'declared-and-disabled-by-hub'].includes(result.installLifecyclePolicy)),
      capabilityAndRiskEvidenceLocated: results.every(result => result.capabilityEvidence === 'passed' && result.riskDisclosureEvidence === 'passed'),
      thirdPartyRuntimeExecuted: false,
    },
    packages: results,
    flowCapabilityGate: policy.flowCapabilityGate,
    conclusion: 'Static artifact inspection passed. Runtime verification and Flow capability completion remain separate fail-closed gates.',
  }
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output: outputPath, packages: results.length, executableFlows: 0 })}\n`)
} finally {
  const guardedRoot = `${resolve(tmpdir())}${sep}`
  const resolvedTemp = resolve(tempRoot)
  if (!resolvedTemp.startsWith(guardedRoot)) throw new Error('refusing to remove static audit path outside temp root')
  await rm(resolvedTemp, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
}
