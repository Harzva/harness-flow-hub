import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshCliPath } from './dsh-cli-lib.mjs'

const outputDir = resolve(process.argv[2] ?? `evidence/flow-capability-workflows/${process.platform}`)
const runnerTemp = resolve(process.env.RUNNER_TEMP ?? '')
if (runnerTemp === resolve('')) throw new Error('RUNNER_TEMP is required')
const verifierRoot = join(runnerTemp, 'harness-flow-capability-workflows')
const cli = dshCliPath()

export function safeEnvironment(home) {
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

function subprocessRuntime(home) {
  return {
    spawn(spec) {
      const [program, ...args] = spec.argv
      if (typeof program !== 'string' || program === '') throw new Error('subprocess argv requires a program')
      const env = safeEnvironment(home)
      for (const [name, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[name]
        else env[name] = String(value)
      }
      const child = spawn(program, args, {
        cwd: spec.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
      const abort = () => child.kill('SIGTERM')
      if (spec.signal?.aborted) abort()
      else spec.signal?.addEventListener('abort', abort, { once: true })
      const done = new Promise((resolveDone, rejectDone) => {
        child.once('error', rejectDone)
        child.once('exit', (code, signal) => {
          spec.signal?.removeEventListener('abort', abort)
          resolveDone({ exitCode: code, signal })
        })
      })
      const read = chunks => ({ text: Buffer.concat(chunks).toString('utf8'), lossy: false })
      return {
        done,
        collected: {
          stdout: { readFrom: () => read(stdout) },
          stderr: { readFrom: () => read(stderr) },
        },
      }
    },
  }
}

async function installExact(home, packageName, version, profile = 'web') {
  requireExit(runDsh(home, ['--profile', profile, '--dump-default-config']), 'profile bootstrap')
  requireExit(runDsh(home, ['plugin', '--profile', profile, 'add', `${packageName}@${version}`, '--save-exact', '--ignore-scripts', '--reporter=silent']), `${packageName} install`)
  const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  if (manifest.dependencies?.[packageName] !== version) throw new Error(`${packageName} exact dependency missing`)
  requireExit(runDsh(home, ['--profile', profile, '--dump-config']), `${packageName} dump-config`)
}

async function assertExactProfileInstall(home, profile, packageName, version) {
  const manifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
  if (manifest.dependencies?.[packageName] !== version) throw new Error(`${packageName} exact Flow dependency missing`)
  requireExit(runDsh(home, ['--profile', profile, '--dump-config']), `${packageName} Flow dump-config`)
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

function workflowContext(services = {}) {
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
      get(name) { return services[name] },
      on() { return () => {} },
    },
  }
}

function assertInside(root, candidate, label) {
  const base = resolve(root)
  const target = resolve(candidate)
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`${label} escaped the synthetic workspace`)
  return target
}

function boundedFileService(workspace) {
  return {
    resolve: async path => assertInside(workspace, path, 'science file path'),
    readText: async path => readFile(assertInside(workspace, path, 'science read'), 'utf8'),
    writeText: async (path, content) => {
      const target = assertInside(workspace, path, 'science write')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    },
    listDir: async path => (await readdir(assertInside(workspace, path, 'science list'), { withFileTypes: true }))
      .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
    readBytes: async (path, _offset, maxBytes) => {
      const bytes = await readFile(assertInside(workspace, path, 'science bytes'))
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new Error('science artifact exceeded the fixture byte cap')
      return bytes
    },
  }
}

function boundedScienceShell(home, workspace) {
  return {
    resolve(spec) {
      assertInside(workspace, spec.workdir, 'science shell cwd')
      return spec
    },
    async run(spec) {
      const cwd = assertInside(workspace, spec.workdir, 'science shell run cwd')
      const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      const args = process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command]
        : ['-lc', spec.command]
      const result = run(command, args, { cwd, env: safeEnvironment(home), timeout: spec.timeoutMs ?? 300_000 })
      return {
        exitCode: result.status ?? 1,
        stdout: { text: result.stdout ?? '', lossy: false },
        stderr: { text: result.stderr ?? '', lossy: false },
      }
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

async function officialAgentToolPipeline(packageRoot, createDefinitions, workspace, action) {
  const packageRequire = createRequire(join(packageRoot, 'package.json'))
  const [{ Context }, { createScope }, { AgentRegistry }, { SystemPrompt }, { ToolRuntime, defineTool }, { VisionToolExposure }, skill] = await Promise.all([
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-scope')).href),
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-agent')).href),
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-tools')).href),
    import(pathToFileURL(join(packageRoot, 'lib', 'exposure.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib', 'skill.js')).href),
  ])
  const root = new Context()
  const previousCwd = process.cwd()
  await root.plugin(AgentRegistry)
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime, { mode: 'native' })
  function visionToolkitFixturePlugin() {}
  visionToolkitFixturePlugin.inject = ['tools', 'agents']
  const pluginFiber = root.plugin(visionToolkitFixturePlugin)
  const pluginCtx = pluginFiber.ctx
  const agent = {
    id: 'fixture-vision-agent', status: 'idle', options: {},
    session: { id: 'fixture-vision-agent', events: [], header: { id: 'fixture-vision-agent', cwd: workspace } },
  }
  const scope = createScope(pluginCtx, agent)
  agent.ctx = scope.ctx.extend({ agent })
  const exposure = new VisionToolExposure(pluginCtx, createDefinitions)
  const disposeActivation = pluginCtx.tools.register(exposure.activationTool)
  const disposeSkill = pluginCtx.tools.register(defineTool({
    name: 'skill', description: 'Synthetic hosted fixture for exact bundled Skill activation.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string', required: true }, content: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: args => {
      if (args.name !== skill.VISION_TOOLS_SKILL_NAME) throw new Error('unexpected fixture Skill')
      return { name: skill.VISION_TOOLS_SKILL_NAME, content: skill.VISION_TOOLS_SKILL_CONTENT }
    },
  }))
  const disposeExposure = exposure.install()
  const disposeAgent = pluginCtx.agents.register(agent)
  process.chdir(workspace)
  try {
    const execute = async (name, args) => {
      const result = await root.tools.execute({
        callId: `fixture-${name}`, name, arguments: args, signal: new AbortController().signal,
        agent,
      })
      if (result.isError) throw new Error(`${name}: ${result.error.message}`)
      return result.value
    }
    const beforeActivation = await root.tools.execute({
      callId: 'fixture-before-skill', name: 'vision_html_screenshot', arguments: {},
      signal: new AbortController().signal, agent,
    })
    if (!beforeActivation.isError) throw new Error('Agent-scoped visual tools were visible before Skill activation')
    const loaded = await execute('skill', { name: skill.VISION_TOOLS_SKILL_NAME })
    if (loaded.name !== skill.VISION_TOOLS_SKILL_NAME || loaded.content !== skill.VISION_TOOLS_SKILL_CONTENT) throw new Error('bundled vision Skill result drifted')
    const value = await action(execute)
    const hiddenActivation = await root.tools.execute({
      callId: 'fixture-activation-hidden', name: 'vision_toolkit_activate', arguments: {},
      signal: new AbortController().signal, agent,
    })
    if (!hiddenActivation.isError) throw new Error('activation bootstrap stayed visible after Agent-scoped activation')
    return { value, agentScopedSkillActivation: true, toolsHiddenBeforeSkill: true, activationBootstrapHiddenAfterSkill: true }
  } finally {
    process.chdir(previousCwd)
    disposeAgent()
    disposeExposure()
    disposeSkill()
    disposeActivation()
    await scope.dispose()
    await pluginFiber.dispose()
    await root.fiber.dispose()
  }
}

async function officialGlobalToolPipeline(packageRoot, definitions, workspace, action) {
  const packageRequire = createRequire(join(packageRoot, 'package.json'))
  const [{ Context }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
    import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-tools')).href),
  ])
  const root = new Context()
  const previousCwd = process.cwd()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime, { mode: 'native' })
  for (const definition of definitions) root.tools.register(definition)
  process.chdir(workspace)
  try {
    return await action(async (name, args) => {
      const result = await root.tools.execute({
        callId: `fixture-${name}`, name, arguments: args, signal: new AbortController().signal,
      })
      if (result.isError) throw new Error(`${name}: ${result.error.message}`)
      return result.value
    })
  } finally {
    process.chdir(previousCwd)
    await root.fiber.dispose()
  }
}

export async function verifyCoding(home, workspace, options = {}) {
  const profile = options.profile ?? 'web'
  if (options.install === false) await assertExactProfileInstall(home, profile, 'dsh-openwolf', '0.9.1')
  else await installExact(home, 'dsh-openwolf', '0.9.1', profile)
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'test'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), '{"name":"coding-flow-fixture","type":"module","scripts":{"test":"node --test"}}\n')
  await writeFile(join(workspace, 'src', 'calc.js'), 'export function add(left, right) {\n  return left - right\n}\n')
  await writeFile(join(workspace, 'test', 'calc.test.js'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/calc.js'\ntest('adds two numbers', () => assert.equal(add(2, 3), 5))\n")

  const initialTest = run(process.execPath, ['--test'], { cwd: workspace, env: safeEnvironment(home) })
  if (initialTest.status === 0) throw new Error('coding fixture must prove the initial defect')

  const packageRoot = await realpath(join(home, 'profiles', profile, 'node_modules', 'dsh-openwolf'))
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
      exactProfileInstall: true, installedByFlowTransaction: options.install === false, lifecycleScriptsDisabled: true,
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

export async function verifyResearch(home, workspace, options = {}) {
  const profile = options.profile ?? 'web'
  if (options.install === false) await assertExactProfileInstall(home, profile, 'dsh-science-workbench', '0.1.1')
  else await installExact(home, 'dsh-science-workbench', '0.1.1', profile)
  await mkdir(workspace, { recursive: true })
  const packageRoot = await realpath(join(home, 'profiles', profile, 'node_modules', 'dsh-science-workbench'))
  const services = {
    fs: boundedFileService(workspace),
    shell: boundedScienceShell(home, workspace),
    sandboxPolicy: { workspaceRoot: workspace },
  }
  const plugin = await import(pathToFileURL(join(packageRoot, 'lib', 'index.js')).href)
  const harness = workflowContext(services)
  const dispose = plugin.apply(harness.ctx)
  if (typeof dispose === 'function') harness.cleanups.push(dispose)
  const requiredTools = ['bio_set_projects_dir', 'bio_init_project', 'bio_run_cell', 'bio_add_feedback', 'bio_rerun_cell', 'bio_get_project']
  if (!requiredTools.every(name => harness.definitions.has(name))) throw new Error('science workbench did not register the required research tools')

  try {
    return await officialGlobalToolPipeline(packageRoot, [...harness.definitions.values()], workspace, async execute => {
      const projectsDir = join(workspace, 'research-projects')
      await execute('bio_set_projects_dir', { dir: projectsDir })
      const initialized = await execute('bio_init_project', { name: 'evidence_fixture', language: 'python' })
      const projectRoot = assertInside(projectsDir, initialized.root, 'science project root')
      const sourcePath = join(projectRoot, 'data', 'source.txt')
      await mkdir(dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'claim-alpha\tsynthetic-source\tverified\n', 'utf8')
      const sourceBefore = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
      const initialCode = [
        'from pathlib import Path',
        'import json',
        "source = Path('data/source.txt').read_text(encoding='utf-8').strip()",
        "Path('evidence.json').write_text(json.dumps({'source': source, 'citationStatus': 'verified', 'limitations': ['synthetic fixture only']}, indent=2), encoding='utf-8')",
        "Path('report.md').write_text('# Research fixture\\n\\nFact: claim-alpha.\\n\\nInference: none.\\n\\nLimitation: synthetic fixture only.\\n', encoding='utf-8')",
        "Path('figures/evidence.svg').write_text('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"320\" height=\"120\"><rect width=\"320\" height=\"120\" fill=\"#eef2ff\"/><text x=\"20\" y=\"68\">verified evidence</text></svg>', encoding='utf-8')",
      ].join('\n')
      const first = await execute('bio_run_cell', {
        name: 'evidence_fixture', title: 'Evidence trace', code: initialCode, language: 'python',
        params: { fixture: 'synthetic' }, seed: 42, inputs: ['data/source.txt'], outputs: ['evidence.json', 'report.md'],
      })
      if (first.status !== 'ok' || first.artifacts.length < 3) {
        throw new Error(`science workbench initial evidence cell failed:status=${first.status};artifacts=${first.artifacts.length};stdout=${String(first.stdoutTail ?? '').trim() !== ''};stderr=${String(first.stderrTail ?? '').trim() !== ''}`)
      }
      const firstFigure = first.artifacts.find(path => path.endsWith('.svg'))
      if (firstFigure === undefined) throw new Error('science workbench did not register the evidence figure')
      const feedback = await execute('bio_add_feedback', {
        name: 'evidence_fixture', artifactPath: firstFigure, text: 'Make the evidence status visually explicit.',
      })
      if (feedback.feedbackCount !== 1) throw new Error('science workbench feedback lineage failed')
      const revisedCode = initialCode.replace('verified evidence', 'verified evidence - revised').replace('#eef2ff', '#dcfce7')
      const rerun = await execute('bio_rerun_cell', { name: 'evidence_fixture', cellId: first.cellId, editedCode: revisedCode })
      if (rerun.status !== 'ok' || rerun.derivedFrom !== first.cellId || rerun.artifacts.length < 1) throw new Error('science workbench derived rerun failed')
      const project = await execute('bio_get_project', { name: 'evidence_fixture' })
      const manifest = project.current?.manifest
      if (manifest?.cells?.length !== 2 || manifest?.artifacts?.length < 4) throw new Error('science workbench manifest lineage incomplete')
      if (!manifest.artifacts.every(artifact => typeof artifact.outputHash === 'string' && artifact.outputHash.length === 64)) throw new Error('science workbench artifact provenance hashes incomplete')
      const sourceAfter = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
      if (sourceAfter !== sourceBefore) throw new Error('science workbench modified the synthetic source')
      const commits = requireExit(run('git', ['rev-list', '--count', 'HEAD'], { cwd: projectRoot, env: safeEnvironment(home) }), 'science workbench git history')
      const commitCount = Number.parseInt(commits.stdout.trim(), 10)
      if (!Number.isInteger(commitCount) || commitCount < 3) throw new Error('science workbench provenance commits incomplete')

      return {
        state: 'passed', package: 'dsh-science-workbench', version: '0.1.1',
        exactProfileInstall: true, installedByFlowTransaction: options.install === false, lifecycleScriptsDisabled: true,
        workflow: ['bio_set_projects_dir', 'bio_init_project', 'bio_run_cell', 'bio_add_feedback', 'bio_rerun_cell', 'bio_get_project'],
        officialToolRuntimePipeline: true, registeredTools: requiredTools,
        initialCellPassed: true, derivedRerunPassed: true,
        cells: manifest.cells.length, artifacts: manifest.artifacts.length, provenanceCommits: commitCount,
        artifactHashesComplete: true, feedbackLineageRecorded: true, sourcePreserved: true,
        syntheticWorkspaceOnly: true, userContentUsed: false, networkCalled: false,
        limitation: 'The exact Science Workbench workflow executed on a synthetic local fixture; memory plugins, external retrieval, signed Registry, and full Flow installation remain separate gates.',
      }
    })
  } finally {
    for (const cleanup of harness.cleanups.reverse()) await cleanup()
  }
}

export async function verifyUi(home, workspace, options = {}) {
  const profile = options.profile ?? 'web'
  if (options.install === false) await assertExactProfileInstall(home, profile, '@anionex/dsh-vision-toolkit', '0.1.8')
  else await installExact(home, '@anionex/dsh-vision-toolkit', '0.1.8', profile)
  const packageRoot = await realpath(join(home, 'profiles', profile, 'node_modules', '@anionex', 'dsh-vision-toolkit'))
  const example = join(packageRoot, 'examples', 'ui-restoration')
  const packagedUpstreamRoot = join(packageRoot, 'vendor', 'agent-vision-toolkit')
  await mkdir(workspace, { recursive: true })
  for (const name of ['initial.html', 'implementation.html']) await cp(join(example, name), join(workspace, name))
  for (const name of ['reference.png', 'initial.png', 'implementation.png']) await cp(join(example, 'assets', name), join(workspace, name))
  const upstreamRoot = join(workspace, 'pinned-agent-vision-toolkit')
  await cp(packagedUpstreamRoot, upstreamRoot, { recursive: true })

  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const dependencyProbe = requireExit(run(python, ['-c', 'import json; from importlib.metadata import version; print(json.dumps({"pillow":version("pillow"),"numpy":version("numpy"),"vtracer":version("vtracer")}))']), 'Vision runtime dependencies')
  const dependencies = JSON.parse(dependencyProbe.stdout)
  const [{ resolveConfig }, { UpstreamAdapter }, { VisionToolkitRuntime }, { createVisionTools }] = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'lib', 'config.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib', 'upstream.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib', 'runtime.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib', 'tools.js')).href),
  ])
  const runtimeCtx = {
    subprocess: subprocessRuntime(home),
    credentials: { resolve: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const config = resolveConfig({ runtime: { mode: 'external', agentVisionToolkitPath: upstreamRoot, python }, allowedDirs: [] })
  const adapter = new UpstreamAdapter(runtimeCtx, config)
  await adapter.prepare()
  const runtime = new VisionToolkitRuntime(runtimeCtx, config, adapter)
  const pipeline = await officialAgentToolPipeline(packageRoot, () => createVisionTools(runtime), workspace, async execute => {
    const renderedInitial = await execute('vision_html_screenshot', { source: 'initial.html', width: 1200, height: 720, scale: 1, output: 'runner-initial.png' })
    const renderedFinal = await execute('vision_html_screenshot', { source: 'implementation.html', width: 1200, height: 720, scale: 1, output: 'runner-final.png' })
    const renderedInitialDiff = await execute('vision_pixel_diff', { original: 'reference.png', rebuilt: renderedInitial.artifact.path, grid: 8, top: 6, runName: 'runner-initial-diff' })
    const renderedFinalDiff = await execute('vision_pixel_diff', { original: 'reference.png', rebuilt: renderedFinal.artifact.path, grid: 8, top: 6, runName: 'runner-final-diff' })
    const canonicalInitialDiff = await execute('vision_pixel_diff', { original: 'reference.png', rebuilt: 'initial.png', grid: 8, top: 6, runName: 'canonical-initial-diff' })
    const canonicalFinalDiff = await execute('vision_pixel_diff', { original: 'reference.png', rebuilt: 'implementation.png', grid: 8, top: 6, runName: 'canonical-final-diff' })
    return { renderedInitial, renderedFinal, renderedInitialDiff, renderedFinalDiff, canonicalInitialDiff, canonicalFinalDiff }
  })

  const { renderedInitial, renderedFinal, renderedInitialDiff, renderedFinalDiff, canonicalInitialDiff, canonicalFinalDiff } = pipeline.value

  const runnerInitial = renderedInitialDiff.overallDifferencePct
  const runnerFinal = renderedFinalDiff.overallDifferencePct
  const canonicalInitial = canonicalInitialDiff.overallDifferencePct
  const canonicalFinal = canonicalFinalDiff.overallDifferencePct
  if (canonicalInitial < 1 || canonicalFinal > 0.02) throw new Error('portable UI restoration thresholds failed')
  if (!(runnerFinal < runnerInitial)) throw new Error('current runner rendering did not improve over the initial reconstruction')
  if (renderedInitial.width !== 1200 || renderedInitial.height !== 720 || renderedFinal.width !== 1200 || renderedFinal.height !== 720) throw new Error('native HTML renderer dimensions were not confirmed')

  return {
    state: 'passed', package: '@anionex/dsh-vision-toolkit', version: '0.1.8',
    exactProfileInstall: true, installedByFlowTransaction: options.install === false, lifecycleScriptsDisabled: true,
    workflow: ['tools-hidden-before-skill', 'vision-tools-skill', 'agent-scoped-activation', 'vision_html_screenshot-initial', 'vision_pixel_diff-initial', 'vision_html_screenshot-final', 'vision_pixel_diff-final', 'activation-bootstrap-hidden', 'numeric-acceptance'],
    runtime: { python: 'available', dependencies, chromeFamily: 'available', nativeDefinitions: ['vision_html_screenshot', 'vision_pixel_diff'], officialToolRuntimePipeline: true, agentScopedSkillActivation: pipeline.agentScopedSkillActivation },
    canonical: { initialDifferencePct: canonicalInitial, finalDifferencePct: canonicalFinal },
    currentRunner: { initialDifferencePct: runnerInitial, finalDifferencePct: runnerFinal, improved: true },
    localOnly: true, externalVisionApiCalled: false, credentialConfigured: false,
    artifactsWrittenInsideSyntheticWorkspace: true, userContentUsed: false,
    nativeToolDefinitionsExecuted: true,
    toolsHiddenBeforeSkill: pipeline.toolsHiddenBeforeSkill,
    activationBootstrapHiddenAfterSkill: pipeline.activationBootstrapHiddenAfterSkill,
    limitation: 'The exact package native tool definitions, official ToolRuntime pipeline, and Agent-scoped Skill activation executed; signed Registry and full Flow installation remain separate gates.',
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.DSH_FLOW_WORKFLOW_ALLOWED !== 'hosted-ephemeral') {
    throw new Error('Flow capability workflows are restricted to an explicitly enabled GitHub-hosted ephemeral runner')
  }
  await mkdir(verifierRoot, { recursive: true })
  await mkdir(outputDir, { recursive: true })
  const root = await mkdtemp(join(verifierRoot, 'run-'))
  let result
  try {
    const codingHome = join(root, 'coding-home')
    const researchHome = join(root, 'research-home')
    const uiHome = join(root, 'ui-home')
    await mkdir(codingHome, { recursive: true })
    await mkdir(researchHome, { recursive: true })
    await mkdir(uiHome, { recursive: true })
    const coding = await verifyCoding(codingHome, join(root, 'coding-workspace'))
    const research = await verifyResearch(researchHome, join(root, 'research-workspace'))
    const ui = await verifyUi(uiHome, join(root, 'ui-workspace'))
    result = {
      schemaVersion: 1, verifiedAt: new Date().toISOString(),
      subject: 'Corrected Coding, Research, and UI Flow capability workflows on exact npm artifacts',
      environment: { os: process.platform, arch: process.arch, node: process.version, dsh: '0.1.0-rc.6', runner: 'github-hosted-ephemeral' },
      isolation: { freshDshHomePerFlow: true, childEnvironmentAllowlisted: true, repositorySecretsForwarded: false, privatePathsRecorded: false },
      coding, research, ui, result: 'passed',
      capabilityDecision: {
        codingExpert: 'fixture-workflow-passed',
        researchExpert: 'science-workbench-fixture-workflow-passed',
        uiDesignStudio: 'agent-scoped-skill-and-tool-runtime-workflow-passed',
        registryVerificationStateChanged: false,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result = { schemaVersion: 1, verifiedAt: new Date().toISOString(), subject: 'Corrected Coding, Research, and UI Flow capability workflows on exact npm artifacts', environment: { os: process.platform, arch: process.arch, node: process.version, dsh: '0.1.0-rc.6', runner: 'github-hosted-ephemeral' }, result: 'failed', error: message.replaceAll(/[A-Za-z]:[\\/][^\s;]+|\/(?:home|Users|tmp)\/[^\s;]+/g, '<redacted-path>').slice(0, 300) }
  } finally {
    const resolvedRoot = resolve(root)
    if (!resolvedRoot.startsWith(`${resolve(verifierRoot)}${sep}`)) throw new Error('refusing to remove capability verifier path outside guarded root')
    await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }

  const output = join(outputDir, `m3-flow-capability-workflows-${process.platform}-2026-08-17.json`)
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: result.result === 'passed', output: basename(output) })}\n`)
  if (result.result !== 'passed') process.exitCode = 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()
