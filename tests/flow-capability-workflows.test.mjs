import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const script = await readFile(new URL('../scripts/verify-flow-capability-workflows.mjs', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../.github/workflows/registry.yml', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('capability workflow verifier stays hosted, keyless, synthetic and exact', () => {
  assert.match(script, /GITHUB_ACTIONS !== 'true'/)
  assert.match(script, /DSH_FLOW_WORKFLOW_ALLOWED !== 'hosted-ephemeral'/)
  assert.match(script, /dsh-openwolf', '0\.9\.1'/)
  assert.match(script, /dsh-science-workbench', '0\.1\.1'/)
  assert.match(script, /@anionex\/dsh-vision-toolkit', '0\.1\.8'/)
  assert.match(script, /--ignore-scripts/)
  assert.match(script, /userContentUsed: false/)
  assert.match(script, /externalVisionApiCalled: false/)
  assert.match(script, /registryVerificationStateChanged: false/)
  assert.doesNotMatch(script, /process\.env\.(?:DEEPSEEK|OPENAI|ANTHROPIC|VISION).*KEY/)
})

test('coding fixture calls exact openwolf tools before correction and tests', () => {
  for (const name of ['wolf_refresh', 'wolf_map', 'wolf_file']) assert.match(script, new RegExp(`'${name}'`))
  assert.match(script, /initialTest\.status === 0/)
  assert.match(script, /left - right/)
  assert.match(script, /left \+ right/)
  assert.match(script, /node-test-pass/)
})

test('Research fixture executes a provenance workflow without user data or network', () => {
  for (const name of ['bio_set_projects_dir', 'bio_init_project', 'bio_run_cell', 'bio_add_feedback', 'bio_rerun_cell', 'bio_get_project']) {
    assert.match(script, new RegExp(`'${name}'`))
  }
  assert.match(script, /officialGlobalToolPipeline/)
  assert.match(script, /artifactHashesComplete: true/)
  assert.match(script, /feedbackLineageRecorded: true/)
  assert.match(script, /sourcePreserved: true/)
  assert.match(script, /science-workbench-fixture-workflow-passed/)
  assert.match(script, /initial evidence cell failed:status=/)
  assert.match(script, /networkCalled: false/)
})

test('UI fixture renders local HTML and enforces pixel-backed improvement', () => {
  assert.match(script, /vision_html_screenshot/)
  assert.match(script, /vision_pixel_diff/)
  assert.match(script, /new UpstreamAdapter/)
  assert.match(script, /new VisionToolkitRuntime/)
  assert.match(script, /createVisionTools\(runtime\)/)
  assert.match(script, /root\.plugin\(ToolRuntime/)
  assert.match(script, /officialAgentToolPipeline/)
  assert.match(script, /new VisionToolExposure/)
  assert.match(script, /pluginCtx\.agents\.register\(agent\)/)
  assert.match(script, /execute\('skill', \{ name: skill\.VISION_TOOLS_SKILL_NAME \}\)/)
  assert.match(script, /root\.tools\.execute/)
  assert.match(script, /officialToolRuntimePipeline: true/)
  assert.match(script, /agentScopedSkillActivation: pipeline\.agentScopedSkillActivation/)
  assert.match(script, /toolsHiddenBeforeSkill: pipeline\.toolsHiddenBeforeSkill/)
  assert.match(script, /activationBootstrapHiddenAfterSkill: pipeline\.activationBootstrapHiddenAfterSkill/)
  assert.match(script, /agent-scoped-skill-and-tool-runtime-workflow-passed/)
  assert.match(script, /canonicalInitial < 1 \|\| canonicalFinal > 0\.02/)
  assert.match(script, /runnerFinal < runnerInitial/)
  assert.match(script, /Agent-scoped Skill activation executed/)
})

test('Registry hosted matrix runs and retains capability workflow evidence', () => {
  assert.equal(packageJson.scripts['flow:verify-capability-workflows'], 'node scripts/verify-flow-capability-workflows.mjs')
  assert.match(workflow, /actions\/setup-python@v5/)
  assert.match(workflow, /pillow==12\.3\.0 numpy==2\.4\.6 vtracer==0\.6\.15/)
  assert.match(workflow, /Verify corrected Coding, Research, and UI capability workflows/)
  assert.match(workflow, /DSH_FLOW_WORKFLOW_ALLOWED: hosted-ephemeral/)
  assert.match(workflow, /evidence\/flow-capability-workflows\/\*\*\/\*\.json/)
})
