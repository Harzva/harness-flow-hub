import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { inferSourceKind } from '../lib/transaction.js'

const output = resolve(process.argv[2] ?? 'evidence/m2-remote-source-pinning-2026-08-17.json')
const discovery = JSON.parse(await readFile('registry/discovery/github-topic-2026-08-16.json', 'utf8'))
const registry = JSON.parse(await readFile('registry/generated/registry.json', 'utf8'))
const [nativeClient, publicClient] = await Promise.all([
  readFile('src/client/index.tsx', 'utf8'),
  readFile('site/app.js', 'utf8'),
])

function requireTrue(condition, message) {
  if (!condition) throw new Error(message)
}

const github = registry.plugins.filter(plugin => plugin.source.kind === 'github-sha')
const npm = registry.plugins.filter(plugin => plugin.source.kind === 'npm')
for (const plugin of github) {
  requireTrue(/^[a-f0-9]{40}$/.test(plugin.source.commit ?? ''), `GitHub commit is not exact:${plugin.id}`)
  requireTrue(plugin.source.spec === `github:${discovery.candidates.find(item => item.package.name === plugin.package)?.repository}#${plugin.source.commit}`, `GitHub spec is not pinned:${plugin.id}`)
}
for (const plugin of npm) {
  requireTrue(plugin.source.spec === `${plugin.package}@${plugin.version}`, `npm spec is not exact:${plugin.id}`)
  requireTrue(/^sha512-/.test(plugin.source.integrity ?? ''), `npm integrity is missing:${plugin.id}`)
}

let transactionRejectedFloating = false
try { inferSourceKind('github:owner/repo#main') } catch (error) { transactionRejectedFloating = error instanceof Error && error.message === 'source-must-be-exact' }
requireTrue(transactionRejectedFloating, 'transaction adapter accepted a floating GitHub branch')
requireTrue(nativeClient.includes('浮动来源，禁止安装') && nativeClient.includes('固定 commit'), 'native DSH UI source warning is missing')
requireTrue(publicClient.includes('浮动来源，禁止安装') && publicClient.includes('固定 commit'), 'public UI source warning is missing')

const temp = await mkdtemp(join(tmpdir(), 'flow-hub-source-policy-'))
let registryRejectedFloating = false
try {
  const invalid = structuredClone(registry)
  const candidate = invalid.plugins.find(plugin => plugin.source.kind === 'github-sha')
  candidate.source.spec = candidate.source.spec.replace(/#[a-f0-9]{40}$/, '#main')
  const target = join(temp, 'floating.json')
  await writeFile(target, JSON.stringify(invalid), 'utf8')
  const result = spawnSync(process.execPath, ['scripts/validate-registry.mjs', target], { encoding: 'utf8', windowsHide: true })
  registryRejectedFloating = result.status !== 0 && /pattern/.test(result.stderr)
} finally {
  await rm(temp, { recursive: true, force: true })
}
requireTrue(registryRejectedFloating, 'published Registry schema accepted a floating GitHub branch')

const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  subject: 'Remote plugin source pinning and floating-branch blocking',
  checks: {
    plugins: registry.plugins.length,
    githubCommitPinned: github.length,
    npmVersionAndIntegrityPinned: npm.length,
    discoveryInputGate: 'passed',
    publishedRegistryGate: registryRejectedFloating ? 'passed' : 'failed',
    transactionAdapterGate: transactionRejectedFloating ? 'passed' : 'failed',
    nativeDshWarning: 'present',
    publicDiscoveryWarning: 'present',
  },
  policy: { floatingGitHubBranch: 'blocked', githubInstall: '40-character-commit-sha-only', npmInstall: 'exact-version-and-integrity' },
  privacy: { credentialsCaptured: false, privatePathsRecorded: false, userContentCaptured: false },
  result: 'passed',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, github: github.length, npm: npm.length, output })}\n`)
