import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createInstallPlan, executeInstallPlan } from '../lib/transaction.js'
import { runDsh } from './dsh-cli-lib.mjs'

const projectRoot = resolve('.')
const output = resolve(process.argv[2] ?? 'evidence/m2-transaction-adapters-2026-08-16.json')
const tempRoot = resolve('../../work/transaction-adapter-verifier')
const tgz = resolve('artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const localDirectory = resolve('fixtures/hello-bundle')
const githubSha = 'github:Harzva/dsh-flow-hub-hello-fixture#770891307389487f6e4dc6bc4bd7a6db65d5c087'
const registryPort = 48739
const registryUrl = `http://127.0.0.1:${registryPort}/`
const require = createRequire(import.meta.url)
const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
const dshCli = resolve(dirname(packagePath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh)
await mkdir(tempRoot, { recursive: true })

function assert(condition, message) { if (!condition) throw new Error(message) }

async function startRegistry() {
  const child = spawn(process.execPath, [resolve('scripts/fixture-registry.mjs'), tgz, String(registryPort)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = await new Promise((resolveReady, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error(`fixture registry timeout: ${stderr}`)), 10_000)
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
      const line = stdout.split(/\r?\n/, 1)[0]
      if (line.endsWith('}')) {
        clearTimeout(timeout)
        try { resolveReady(JSON.parse(line)) } catch (error) { reject(error) }
      }
    })
    child.on('exit', code => { if (code !== null) reject(new Error(`fixture registry exited ${code}: ${stderr}`)) })
  })
  return { child, ready }
}

async function verifyAdapter(adapter) {
  const home = await mkdtemp(join(tempRoot, `dsh-home-${adapter.kind}-`))
  const profile = 'web'
  try {
    const bootstrap = runDsh(dshCli, home, ['--profile', profile, '--dump-default-config'])
    assert(bootstrap.status === 0, `${adapter.kind} profile bootstrap failed: ${bootstrap.stderr}`)
    if (adapter.registry) await writeFile(join(home, 'profiles', profile, '.npmrc'), `@harness-flow:registry=${adapter.registry}\n`, 'utf8')
    const plan = createInstallPlan({
      action: 'add', profile, packageName: '@harness-flow/hello-bundle', sourceSpec: adapter.spec,
      verification: 'trusted-fixture', signature: 'not-applicable-trusted-fixture',
      ...(adapter.networkEndpoint ? { networkEndpoint: adapter.networkEndpoint } : {}),
    })
    const add = await executeInstallPlan(plan, { home, dshCli, dshVersion: pkg.version })
    assert(add.ok, `${adapter.kind} add failed: ${add.error ?? 'unknown'}`)
    const manifestPath = join(home, 'profiles', profile, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert(typeof manifest.dependencies?.['@harness-flow/hello-bundle'] === 'string', `${adapter.kind} dependency missing`)
    const dump = runDsh(dshCli, home, ['--profile', profile, '--dump-config'])
    assert(dump.status === 0, `${adapter.kind} dump-config failed`)
    const removePlan = createInstallPlan({
      action: 'remove', profile, packageName: '@harness-flow/hello-bundle', sourceSpec: adapter.spec,
      verification: 'trusted-fixture', signature: 'not-applicable-trusted-fixture',
      ...(adapter.networkEndpoint ? { networkEndpoint: adapter.networkEndpoint } : {}),
    })
    const remove = await executeInstallPlan(removePlan, { home, dshCli, dshVersion: pkg.version })
    assert(remove.ok, `${adapter.kind} remove failed: ${remove.error ?? 'unknown'}`)
    return {
      kind: adapter.kind, source: adapter.publicSource, add: { ok: true, phases: add.phases, preflight: add.preflight },
      installedDependency: manifest.dependencies['@harness-flow/hello-bundle'], dumpConfig: 'passed', remove: { ok: true, phases: remove.phases },
    }
  } finally {
    const guardedRoot = `${tempRoot}${sep}`
    if (!home.startsWith(guardedRoot)) throw new Error('refusing to remove verifier home outside temp root')
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

await mkdir(dirname(output), { recursive: true })
let registry
try {
  registry = await startRegistry()
  const adapters = [
    { kind: 'npm', spec: '@harness-flow/hello-bundle@0.0.1-m0', publicSource: '@harness-flow/hello-bundle@0.0.1-m0 (loopback fixture Registry)', registry: registryUrl, networkEndpoint: `${registryUrl}%40harness-flow%2Fhello-bundle` },
    { kind: 'tgz', spec: tgz, publicSource: relative(projectRoot, tgz).replaceAll('\\', '/') },
    { kind: 'github-sha', spec: githubSha, publicSource: githubSha },
    { kind: 'local-directory', spec: localDirectory, publicSource: 'fixtures/hello-bundle' },
  ]
  const results = []
  for (const adapter of adapters) results.push(await verifyAdapter(adapter))
  const evidence = {
    milestone: 'M2-four-transaction-source-adapters', date: new Date().toISOString(), dshVersion: pkg.version,
    privatePathsRecorded: false, lifecycleScriptsDisabled: true, allPassed: results.every(item => item.add.ok && item.remove.ok), adapters: results,
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, output, adapters: results.map(item => item.kind), dshVersion: pkg.version })}\n`)
} finally {
  if (registry?.child) registry.child.kill('SIGTERM')
}
