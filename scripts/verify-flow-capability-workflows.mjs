import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshCliPath } from './dsh-cli-lib.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.DSH_FLOW_WORKFLOW_ALLOWED !== 'hosted-ephemeral') {
  throw new Error('Flow capability workflows are restricted to an explicitly enabled GitHub-hosted ephemeral runner')
}

const outputDir = resolve(process.argv[2] ?? `evidence/flow-capability-workflows/${process.platform}`)
const runnerTemp = resolve(process.env.RUNNER_TEMP ?? '')
if (runnerTemp === resolve('')) throw new Error('RUNNER_TEMP is required')
const verifierRoot = join(runnerTemp, 'harness-flow-capability-workflows')
const cli = dshCliPath()

function safeEnvironment(home) {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'PROGRAMFILES(X86)',
  ]
  const env = {}
  for (const name of allowed) if (typeof process.env[name] === 'string') env[name] = process.env[name]
  return { ...env, DSH_HOME: home, CI: 'true', NO_COLOR: '1' }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 180_000,
    maxBuffer: 8 * 1024 * 1024, cwd: options.cwd, env: options.env,
  })
}

function requireExit(result, label) {
  if (result.status !== 0) {
    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
      .replaceAll(/[A-Za-z]:[\\/][^\s;]+|\/(?:home|Users|tmp)\/[^\s;]+/g, '<redacted-path>')
      .replaceAll(/\s+/g, ' ').trim().slice(0, 300)
    throw new Error(`${label} failed with exit ${result.status ?? 'none'}${diagnostic === '' ? '' : `: ${diagnostic}`}`)
  }
  return result
}

function runDsh(home, args) {
  return run(process.execPath, [cli, ...args], { env: safeEnvironment(home) })
}

async function installExact(home, packageName, version) {
  requireExit(runDsh(home, ['--profile', 'web', '--dump-default-config']), 'profile bootstrap')
  requireExit(runDsh(home, ['plugin', '--profile', 'web', 'add', `${packageName}@${version}`, '--save-exact', '--ignore-scripts', '--reporter=silent']), `${packageName} install`)
  const manifest = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  if (manifest.dependencies?.[packageName] !== version) throw new Error(`${packageName} exact dependency missing`)
  requireExit(runDsh(home, ['--profile', 'web', '--dump-config']), `${packageName} dump-config`)
}

function openwolfConfig() {
  return {
    maxMapBytes: 16_384, maxFileBytes: 65_536, maxFiles: 100,
    watch: false, injectAgentsMd: false, agentsMdFile: 'AGENTS.md', useGitignore: true,
    ignore: ['node_modules', '.git', 'dist', 'coverage'], hidden: false, symbols: true,
    symbolBackend: 'regex', debounceMs: 0, sortBy: 'path', brainEnabled: true,
    brainDir: '.dshwolf', sessionDigestBudgetTokens: 512, rescanIntervalHours: 6,
    symbolThresholdTokens: 100, digestEnabled: false, interceptReads: false,
    interceptWrites: false, compactionSurvival: false, skillsEnabled: false, autoRescanMinutes: 0,
  }
}

function workflowContext() {
  const definitions = new Map()
  const cleanups = []
  return {
    definitions,
    cleanups,
    ctx: {
      tools: {
        register(definition) {
          if (definitions.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
          definitions.set(definition.name, definition)
          return () => definitions.delete(definition.name)
        },
      },
      effect(factory) {
        const cleanup = factory()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      get() { return undefined },
      on() { return () => {} },
    },
  }
}

async function executeDefinition(definitions, name, args, workspace) {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`tool ${name} was not registered by the exact package`)
  return definition.execute(args, {
    callId: `fixture-${name}`, name, arguments: args, signal: new AbortController().signal,
    agent: { session: { header: { id: 'fixture-session', cwd: workspace } } },
    deferContext() {},
  })
}

async function verifyCoding(home, workspace) {
  await installExact(home, 'dsh-openwolf', '0.9.1')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'test'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), '{"name":"coding-flow-fixture","type":"module","scripts":{"test":"node --test"}}\n')
  await writeFile(join(workspace, 'src', 'calc.js'), 'export function add(left, right) {\n  return left - right\n}\n')
  await writeFile(join(workspace, 'test', 'calc.test.js'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/calc.js'\ntest('adds two numbers', () => assert.equal(add(2, 3), 5))\n")

  const initialTest = run(process.execPath, ['--test'], { cwd: workspace, env: safeEnvironment(home) })
  if (initialTest.status === 0) throw new Error('coding fixture must prove the initial defect')

  const packageRoot = await realpath(join(home, 'profiles', 'web', 'node_modules', 'dsh-openwolf'))
  const plugin = await import(pathToFileURL(join(packageRoot, 'lib', 'index.js')).href)
  const harness = workflowContext()
  const dispose = plugin.apply(harness.ctx, openwolfConfig())
  if (typeof dispose === 'function') harness.cleanups.push(dispose)
  try {
    const refreshedBefore = await executeDefinition(harness.definitions, 'wolf_refresh', {}, workspace)
    const mapBefore = await executeDefinition(harness.definitions, 'wolf_map', { refresh: false }, workspace)
    const fileBefore = await executeDefinition(harness.definitions, 'wolf_file', { path: 'src/calc.js' }, workspace)
    if (refreshedBefore.totalFiles < 3 || !mapBefore.map.includes('src/calc.js')) throw new Error('openwolf map omitted the defect file')
    if (fileBefore.exists !== true || !fileBefore.preview?.includes('left - right')) throw new Error('openwolf digest did not expose the defect')

    await writeFile(join(workspace, 'src', 'calc.js'), 'export function add(left, right) {\n  return left + right\n}\n')
    const refreshedAfter = await executeDefinition(harness.definitions, 'wolf_refresh', {}, workspace)
    const fileAfter = await executeDefinition(harness.definitions, 'wolf_file', { path: 'src/calc.js' }, workspace)
    const finalTest = requireExit(run(process.execPath, ['--test'], { cwd: workspace, env: safeEnvironment(home) }), 'coding fixture tests')
    if (!fileAfter.preview?.includes('left + right')) throw new Error('openwolf digest did not refresh after the correction')

    return {
      state: 'passed', package: 'dsh-openwolf', version: '0.9.1',
      exactProfileInstall: true, lifecycleScriptsDisabled: true,
      workflow: ['initial-test-failure', 'wolf_refresh', 'wolf_map', 'wolf_file', 'bounded-source-correction', 'wolf_refresh', 'node-test-pass'],
      registeredTools: ['wolf_refresh', 'wolf_map', 'wolf_file'].every(name => harness.definitions.has(name)),
      initialDefectDetected: true, mappedFilesBefore: refreshedBefore.totalFiles,
      mappedFilesAfter: refreshedAfter.totalFiles, finalTestsPassed: finalTest.status === 0,
      writesConfinedToSyntheticWorkspace: true, userContentUsed: false,
    }
  } finally {
    for (const cleanup of harness.cleanups.reverse()) await cleanup()
  }
}

function differenceOf(output) {
  const match = /overall difference:\s*([0-9.]+)%/i.exec(output)
  if (match === null) throw new Error('pixel diff output omitted the overall percentage')
  return Number(match[1])
}

async function verifyUi(home, workspace) {
  await installExact(home, '@anionex/dsh-vision-toolkit', '0.1.8')
  const packageRoot = await realpath(join(home, 'profiles', 'web', 'node_modules', '@anionex', 'dsh-vision-toolkit'))
  const example = join(packageRoot, 'examples', 'ui-restoration')
  const packagedScripts = join(packageRoot, 'vendor', 'agent-vision-toolkit', 'skills', 'vision-tools', 'scripts')
  await mkdir(workspace, { recursive: true })
  for (const name of ['initial.html', 'implementation.html']) await cp(join(example, name), join(workspace, name))
  for (const name of ['reference.png', 'initial.png', 'implementation.png']) await cp(join(example, 'assets', name), join(workspace, name))
  for (const name of ['html_shot.py', 'pixel_diff.py']) await cp(join(packagedScripts, name), join(workspace, name))
  const htmlShot = join(workspace, 'html_shot.py')
  const pixelDiff = join(workspace, 'pixel_diff.py')

  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const pillow = requireExit(run(python, ['-c', 'import PIL; print(PIL.__version__)']), 'Pillow availability').stdout.trim()
  const renderInitial = requireExit(run(python, [htmlShot, join(workspace, 'initial.html'), '-o', join(workspace, 'runner-initial.png'), '--width', '1200', '--height', '720']), 'initial HTML screenshot')
  const renderFinal = requireExit(run(python, [htmlShot, join(workspace, 'implementation.html'), '-o', join(workspace, 'runner-final.png'), '--width', '1200', '--height', '720']), 'final HTML screenshot')
  const renderedInitialDiff = requireExit(run(python, [pixelDiff, join(workspace, 'reference.png'), join(workspace, 'runner-initial.png'), '--grid', '8', '--top', '6', '-o', join(workspace, 'runner-initial-heatmap.png')]), 'rendered initial pixel diff')
  const renderedFinalDiff = requireExit(run(python, [pixelDiff, join(workspace, 'reference.png'), join(workspace, 'runner-final.png'), '--grid', '8', '--top', '6', '-o', join(workspace, 'runner-final-heatmap.png')]), 'rendered final pixel diff')
  const canonicalInitialDiff = requireExit(run(python, [pixelDiff, join(workspace, 'reference.png'), join(workspace, 'initial.png'), '--grid', '8', '--top', '6', '-o', join(workspace, 'canonical-initial-heatmap.png')]), 'canonical initial pixel diff')
  const canonicalFinalDiff = requireExit(run(python, [pixelDiff, join(workspace, 'reference.png'), join(workspace, 'implementation.png'), '--grid', '8', '--top', '6', '-o', join(workspace, 'canonical-final-heatmap.png')]), 'canonical final pixel diff')

  const runnerInitial = differenceOf(renderedInitialDiff.stdout)
  const runnerFinal = differenceOf(renderedFinalDiff.stdout)
  const canonicalInitial = differenceOf(canonicalInitialDiff.stdout)
  const canonicalFinal = differenceOf(canonicalFinalDiff.stdout)
  if (canonicalInitial < 1 || canonicalFinal > 0.02) throw new Error('portable UI restoration thresholds failed')
  if (!(runnerFinal < runnerInitial)) throw new Error('current runner rendering did not improve over the initial reconstruction')
  if (!renderInitial.stdout.includes('(1200x720)') || !renderFinal.stdout.includes('(1200x720)')) throw new Error('HTML renderer dimensions were not confirmed')

  return {
    state: 'passed', package: '@anionex/dsh-vision-toolkit', version: '0.1.8',
    exactProfileInstall: true, lifecycleScriptsDisabled: true,
    workflow: ['local-reference', 'render-initial-html', 'pixel-diff-initial', 'render-final-html', 'pixel-diff-final', 'numeric-acceptance'],
    runtime: { python: 'available', pillow, chromeFamily: 'available' },
    canonical: { initialDifferencePct: canonicalInitial, finalDifferencePct: canonicalFinal },
    currentRunner: { initialDifferencePct: runnerInitial, finalDifferencePct: runnerFinal, improved: true },
    localOnly: true, externalVisionApiCalled: false, credentialConfigured: false,
    artifactsWrittenInsideSyntheticWorkspace: true, userContentUsed: false,
    limitation: 'The exact package vendor workflow executed, but Agent-scoped activation and native ToolRuntime dispatch remain a separate gate.',
  }
}

await mkdir(verifierRoot, { recursive: true })
await mkdir(outputDir, { recursive: true })
const root = await mkdtemp(join(verifierRoot, 'run-'))
let result
try {
  const codingHome = join(root, 'coding-home')
  const uiHome = join(root, 'ui-home')
  await mkdir(codingHome, { recursive: true })
  await mkdir(uiHome, { recursive: true })
  const coding = await verifyCoding(codingHome, join(root, 'coding-workspace'))
  const ui = await verifyUi(uiHome, join(root, 'ui-workspace'))
  result = {
    schemaVersion: 1, verifiedAt: new Date().toISOString(),
    subject: 'Corrected Coding and UI Flow capability workflows on exact npm artifacts',
    environment: { os: process.platform, arch: process.arch, node: process.version, dsh: '0.1.0-rc.6', runner: 'github-hosted-ephemeral' },
    isolation: { freshDshHomePerFlow: true, childEnvironmentAllowlisted: true, repositorySecretsForwarded: false, privatePathsRecorded: false },
    coding, ui, result: 'passed',
    capabilityDecision: {
      codingExpert: 'fixture-workflow-passed',
      uiDesignStudio: 'vendor-workflow-passed-native-agent-dispatch-pending',
      registryVerificationStateChanged: false,
    },
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  result = { schemaVersion: 1, verifiedAt: new Date().toISOString(), subject: 'Corrected Coding and UI Flow capability workflows on exact npm artifacts', environment: { os: process.platform, arch: process.arch, node: process.version, dsh: '0.1.0-rc.6', runner: 'github-hosted-ephemeral' }, result: 'failed', error: message.replaceAll(/[A-Za-z]:[\\/][^\s;]+|\/(?:home|Users|tmp)\/[^\s;]+/g, '<redacted-path>').slice(0, 300) }
} finally {
  const resolvedRoot = resolve(root)
  if (!resolvedRoot.startsWith(`${resolve(verifierRoot)}${sep}`)) throw new Error('refusing to remove capability verifier path outside guarded root')
  await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}

const output = join(outputDir, `m3-flow-capability-workflows-${process.platform}-2026-08-17.json`)
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: result.result === 'passed', output: basename(output) })}\n`)
if (result.result !== 'passed') process.exitCode = 1
