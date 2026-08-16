import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const windowsPath = resolve(process.argv[2] ?? 'work/ci-capability/windows/m3-flow-capability-workflows-win32-2026-08-17.json')
const linuxPath = resolve(process.argv[3] ?? 'work/ci-capability/linux/m3-flow-capability-workflows-linux-2026-08-17.json')
const output = resolve(process.argv[4] ?? 'evidence/m3-flow-capability-workflows-cross-platform-2026-08-17.json')
const runUrl = process.argv[5] ?? 'https://github.com/Harzva/harness-flow-hub/actions/runs/31975721224'
const baseCommit = process.argv[6] ?? '2c90a62ca4bac2ebad195bc9a0bc367b35d4594d'

function requireTrue(value, message) {
  if (!value) throw new Error(message)
}

const inputs = await Promise.all([windowsPath, linuxPath].map(async path => JSON.parse(await readFile(path, 'utf8'))))
const platforms = {}
for (const input of inputs) {
  const os = input.environment?.os
  requireTrue(os === 'win32' || os === 'linux', 'unexpected capability workflow platform')
  requireTrue(input.result === 'passed', `${os} capability workflows failed`)
  requireTrue(input.environment?.runner === 'github-hosted-ephemeral', `${os} did not use a hosted ephemeral runner`)
  requireTrue(input.isolation?.privatePathsRecorded === false, `${os} recorded private paths`)
  requireTrue(input.isolation?.repositorySecretsForwarded === false, `${os} forwarded repository secrets`)
  requireTrue(input.coding?.package === 'dsh-openwolf' && input.coding?.version === '0.9.1', `${os} coding package drifted`)
  requireTrue(input.coding?.registeredTools === true && input.coding?.initialDefectDetected === true && input.coding?.finalTestsPassed === true, `${os} coding workflow incomplete`)
  requireTrue(input.research?.package === 'dsh-science-workbench' && input.research?.version === '0.1.1', `${os} research package drifted`)
  requireTrue(input.research?.officialToolRuntimePipeline === true && input.research?.initialCellPassed === true && input.research?.derivedRerunPassed === true, `${os} research workflow incomplete`)
  requireTrue(input.research?.artifactHashesComplete === true && input.research?.feedbackLineageRecorded === true && input.research?.sourcePreserved === true, `${os} research provenance incomplete`)
  requireTrue(input.research?.networkCalled === false && input.research?.userContentUsed === false, `${os} research isolation contract failed`)
  requireTrue(input.ui?.package === '@anionex/dsh-vision-toolkit' && input.ui?.version === '0.1.8', `${os} UI package drifted`)
  requireTrue(input.ui?.canonical?.initialDifferencePct >= 1 && input.ui?.canonical?.finalDifferencePct <= 0.02, `${os} portable UI thresholds failed`)
  requireTrue(input.ui?.currentRunner?.improved === true && input.ui.currentRunner.finalDifferencePct < input.ui.currentRunner.initialDifferencePct, `${os} runner UI workflow did not improve`)
  requireTrue(input.ui?.nativeToolDefinitionsExecuted === true && input.ui?.runtime?.officialToolRuntimePipeline === true, `${os} official UI ToolRuntime workflow incomplete`)
  requireTrue(input.ui?.runtime?.agentScopedSkillActivation === true && input.ui?.toolsHiddenBeforeSkill === true && input.ui?.activationBootstrapHiddenAfterSkill === true, `${os} UI Agent-scoped Skill lifecycle incomplete`)
  requireTrue(input.ui?.externalVisionApiCalled === false && input.ui?.credentialConfigured === false && input.ui?.userContentUsed === false, `${os} UI isolation contract failed`)
  requireTrue(input.capabilityDecision?.registryVerificationStateChanged === false, `${os} changed Registry trust from partial workflow evidence`)
  platforms[os] = {
    status: 'passed', node: input.environment.node, dsh: input.environment.dsh,
    coding: {
      package: `${input.coding.package}@${input.coding.version}`,
      workflow: input.coding.workflow,
      mappedFilesBefore: input.coding.mappedFilesBefore,
      mappedFilesAfter: input.coding.mappedFilesAfter,
      finalTestsPassed: input.coding.finalTestsPassed,
    },
    research: {
      package: `${input.research.package}@${input.research.version}`,
      workflow: input.research.workflow,
      officialToolRuntimePipeline: true,
      cells: input.research.cells,
      artifacts: input.research.artifacts,
      provenanceCommits: input.research.provenanceCommits,
      artifactHashesComplete: true,
      feedbackLineageRecorded: true,
      sourcePreserved: true,
      networkCalled: false,
    },
    ui: {
      package: `${input.ui.package}@${input.ui.version}`,
      workflow: input.ui.workflow,
      canonical: input.ui.canonical,
      currentRunner: input.ui.currentRunner,
      nativeToolDefinitionsExecuted: true,
      officialToolRuntimePipeline: true,
      agentScopedSkillActivation: true,
      toolsHiddenBeforeSkill: true,
      activationBootstrapHiddenAfterSkill: true,
      externalVisionApiCalled: false,
    },
  }
}
requireTrue(platforms.win32 !== undefined && platforms.linux !== undefined, 'Windows and Linux evidence are both required')

const report = {
  schemaVersion: 1,
  verifiedAt: inputs.map(input => input.verifiedAt).sort().at(-1),
  subject: 'Cross-platform corrected Coding, Research, and UI Flow capability workflows',
  baseCommit,
  run: runUrl,
  platforms,
  isolation: {
    exactNpmArtifacts: ['dsh-openwolf@0.9.1', 'dsh-science-workbench@0.1.1', '@anionex/dsh-vision-toolkit@0.1.8'],
    lifecycleScriptsDisabled: true,
    syntheticWorkspacesOnly: true,
    userContentUsed: false,
    credentialsConfigured: false,
    externalVisionApiCalled: false,
    privatePathsRecorded: false,
  },
  capabilityDecision: {
    codingExpert: 'fixture-workflow-passed-cross-platform',
    researchExpert: 'science-workbench-fixture-workflow-passed-cross-platform',
    uiDesignStudio: 'agent-scoped-skill-and-tool-runtime-workflow-passed-cross-platform',
    registryVerificationStateChanged: false,
    flowExecutableStateChanged: false,
    reason: 'Exact Coding, Science Workbench, and Agent-scoped UI workflows passed through their DSH tool paths on Windows and Linux; memory/retrieval composition, signed Registry, and empty-environment Flow installation gates remain open.',
  },
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, platforms: Object.keys(platforms).length, registryVerificationStateChanged: false })}\n`)
