import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const verifier = await readFile(new URL('../scripts/verify-flow-empty-environment.mjs', import.meta.url), 'utf8')
const capability = await readFile(new URL('../scripts/verify-flow-capability-workflows.mjs', import.meta.url), 'utf8')
const transaction = await readFile(new URL('../src/transaction.ts', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../.github/workflows/registry.yml', import.meta.url), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('empty-environment verifier binds ephemeral signature, Flow transaction, Profile boot and workflow smoke', () => {
  assert.match(verifier, /DSH_FLOW_EMPTY_ENV_ALLOWED !== 'hosted-ephemeral'/)
  assert.match(verifier, /generateKeyPairSync\('ed25519'\)/)
  assert.match(verifier, /signRegistry\(registryText/)
  assert.match(verifier, /verifyRegistrySignature\(registryText/)
  assert.match(verifier, /compileFlowInstallPlan\(flow, 'safe'/)
  assert.match(verifier, /executeFlowInstallPlan\(plan/)
  assert.match(verifier, /official headless app help probe passed without a model request/)
  assert.match(verifier, /\[cli, '--profile', profile, '--help'\]/)
  assert.match(verifier, /verifyCoding\(home, workspace, options\)/)
  assert.match(verifier, /verifyResearch\(home, workspace, options\)/)
  assert.match(verifier, /verifyUi\(home, workspace, options\)/)
  assert.match(verifier, /stack\.validations\.every\(item => item\.status === 'passed'\)/)
  assert.match(verifier, /privateKeyPersisted: false/)
  assert.match(verifier, /publicRegistryVerificationStateChanged: false/)
  assert.match(verifier, /flowExecutableStateChanged: false/)
})

test('empty-environment verifier uses exact packages, disables scripts and forwards no repository secrets', () => {
  assert.match(verifier, /includeRecommended: false/)
  assert.match(verifier, /safeEnvironment/)
  assert.match(verifier, /childEnvironmentAllowlisted: true/)
  assert.match(verifier, /repositorySecretsForwarded: false/)
  assert.match(verifier, /userContentUsed: false/)
  assert.match(verifier, /lifecycleScriptsDisabled: true/)
  assert.doesNotMatch(verifier, /process\.env\.(?:DEEPSEEK|OPENAI|ANTHROPIC|VISION).*KEY/)
})

test('capability verifier is importable without auto-running and supports an existing Flow Profile', () => {
  assert.match(capability, /fileURLToPath\(import\.meta\.url\) === resolve\(process\.argv\[1\]\)/)
  assert.match(capability, /options\.install === false/)
  assert.match(capability, /assertExactProfileInstall/)
  assert.match(capability, /installedByFlowTransaction: options\.install === false/)
})

test('transaction commits callback validation evidence into the Stack lock and rejects failures or private paths', () => {
  assert.match(transaction, /validateFlow\?:/)
  assert.match(transaction, /flow-validation-task-set-mismatch/)
  assert.match(transaction, /flow-validation-task-failed/)
  assert.match(transaction, /flow-validation-evidence-private-path/)
  assert.match(transaction, /atomicJson\(stackLockPath, completedStack/)
})

test('hosted Windows and Linux job executes and retains empty-environment Flow evidence', () => {
  assert.equal(packageJson.scripts['flow:verify-empty-environment'], 'pnpm build && node scripts/verify-flow-empty-environment.mjs')
  assert.match(workflow, /Verify three signed Flow plans install from empty environments and pass their smoke workflows/)
  assert.match(workflow, /DSH_FLOW_EMPTY_ENV_ALLOWED: hosted-ephemeral/)
  assert.match(workflow, /evidence\/flow-empty-environment\/\*\*\/\*\.json/)
})
