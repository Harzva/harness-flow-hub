import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { dshCliPath, runDsh } from './dsh-cli-lib.mjs'

const registryPath = resolve(process.argv[2] ?? 'registry/generated/registry.json')
const outputDir = resolve(process.argv[3] ?? 'registry/verifications')
const targetSuccesses = Number(process.argv[4] ?? 10)
const dshVersion = process.env.DSH_VERSION ?? '0.1.0-rc.6'
const tempRoot = resolve(process.env.DSH_VERIFIER_TEMP_ROOT ?? '../../work/registry-verifier')
const registry = JSON.parse(await readFile(registryPath, 'utf8'))

function validateSpec(plugin) {
  const spec = plugin.source.spec
  if (plugin.source.kind === 'npm') {
    if (spec !== `${plugin.package}@${plugin.version}`) throw new Error(`npm source is not exact: ${plugin.id}`)
    return spec
  }
  if (plugin.source.kind === 'github-sha') {
    const escaped = plugin.package.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`^github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[a-f0-9]{40}$`).test(spec)) {
      throw new Error(`GitHub source is not pinned to a 40-character SHA: ${plugin.id}`)
    }
    if (plugin.source.commit === undefined || !spec.endsWith(`#${plugin.source.commit}`)) {
      throw new Error(`GitHub source commit mismatch: ${plugin.id}`)
    }
    void escaped
    return spec
  }
  throw new Error(`unsupported automated verification source: ${plugin.source.kind}`)
}

await mkdir(outputDir, { recursive: true })
await mkdir(tempRoot, { recursive: true })
const cli = dshCliPath()
const selected = [...registry.plugins]
  .sort((a, b) => {
    const sourceRank = (value) => value === 'npm' ? 0 : 1
    return sourceRank(a.source.kind) - sourceRank(b.source.kind)
      || Object.keys(a.lifecycleScripts).length - Object.keys(b.lifecycleScripts).length
      || a.id.localeCompare(b.id)
  })
const summary = []
const attempted = new Set()
const registryIds = new Set(registry.plugins.map(plugin => plugin.id))
try {
  for (const name of (await readdir(outputDir)).filter(name => name.endsWith('.json')).sort()) {
    const existing = JSON.parse(await readFile(join(outputDir, name), 'utf8'))
    if (!registryIds.has(existing.subject)) continue
    attempted.add(existing.subject)
    const installed = existing.checks.some(check => check.id === 'package-install' && check.status === 'passed')
    const removed = existing.checks.some(check => check.id === 'package-remove' && check.status === 'passed')
    summary.push({ id: existing.subject, install: installed && removed ? 'passed' : 'failed', state: existing.state })
  }
} catch {}

for (const plugin of selected) {
  if (summary.filter(item => item.install === 'passed').length >= targetSuccesses) break
  if (attempted.has(plugin.id)) continue
  const checks = []
  let home
  try {
    const spec = validateSpec(plugin)
    home = await mkdtemp(join(tempRoot, `${plugin.id}-`))
    const bootstrap = runDsh(cli, home, ['--profile', 'web', '--dump-default-config'])
    if (bootstrap.status !== 0) throw new Error('official profile bootstrap failed')
    checks.push({ id: 'profile-bootstrap', status: 'passed' })

    const install = runDsh(cli, home, [
      'plugin', '--profile', 'web', 'add', spec,
      '--save-exact', '--ignore-scripts', '--reporter=silent',
    ])
    if (install.status !== 0) throw new Error('package installation failed')
    checks.push({ id: 'package-install', status: 'passed', detail: 'lifecycle scripts disabled' })

    const profilePackage = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    if (typeof profilePackage.dependencies?.[plugin.package] !== 'string') {
      throw new Error('installed package was not recorded in profile dependencies')
    }
    checks.push({ id: 'dependency-recorded', status: 'passed' })

    const remove = runDsh(cli, home, [
      'plugin', '--profile', 'web', 'remove', plugin.package, '--reporter=silent',
    ])
    if (remove.status !== 0) throw new Error('package removal failed')
    const after = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    if (after.dependencies?.[plugin.package] !== undefined) throw new Error('package remained after removal')
    checks.push({ id: 'package-remove', status: 'passed' })
    checks.push({ id: 'plugin-boot', status: 'skipped', detail: 'no OS sandbox available; third-party code was not executed' })

    const result = {
      schemaVersion: 1,
      subject: plugin.id,
      state: 'unverified',
      verifiedAt: new Date().toISOString(),
      environment: { os: process.platform, arch: process.arch, node: process.version, dsh: dshVersion },
      checks,
      evidence: [`registry/verifications/${plugin.id}.json`],
    }
    await writeFile(join(outputDir, `${plugin.id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    summary.push({ id: plugin.id, install: 'passed', state: 'unverified' })
  } catch (error) {
    const result = {
      schemaVersion: 1,
      subject: plugin.id,
      state: 'failed',
      verifiedAt: new Date().toISOString(),
      environment: { os: process.platform, arch: process.arch, node: process.version, dsh: dshVersion },
      checks: [...checks, { id: 'package-installation-flow', status: 'failed', detail: error instanceof Error ? error.message : String(error) }],
      evidence: [`registry/verifications/${plugin.id}.json`],
    }
    await writeFile(join(outputDir, `${plugin.id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    summary.push({ id: plugin.id, install: 'failed', state: 'failed' })
  } finally {
    if (home !== undefined) {
      const resolvedHome = resolve(home)
      const guardedRoot = `${resolve(tempRoot)}${sep}`
      if (!resolvedHome.startsWith(guardedRoot)) throw new Error('refusing to remove verifier path outside temp root')
      await rm(resolvedHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {
        // Windows may retain a pnpm handle briefly. A stale verifier temp does not change the result.
      })
    }
  }
}

const passed = summary.filter(item => item.install === 'passed').length
const ok = passed >= targetSuccesses
process.stdout.write(`${JSON.stringify({ ok, targetSuccesses, passed, attempted: summary.length, results: summary })}\n`)
if (!ok) process.exitCode = 1
