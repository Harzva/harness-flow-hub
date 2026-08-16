import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const output = resolve(process.argv[2] ?? 'registry/discovery/github-topic.json')
const targetCount = Number(process.argv[3] ?? 20)
const githubTarget = Math.min(targetCount - 1, Number(process.argv[4] ?? 10))
const asOf = process.env.REGISTRY_AS_OF ?? '2026-08-16'
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'harness-flow-hub-registry-alpha',
  'x-github-api-version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
}

async function getJson(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
  return await response.json()
}

const search = await getJson('https://api.github.com/search/repositories?q=topic%3Adsh-plugin&sort=stars&order=desc&per_page=100')
const ranked = [...search.items].sort((a, b) =>
  (b.stargazers_count - a.stargazers_count) || a.full_name.localeCompare(b.full_name),
)
const candidates = []

for (const repo of ranked) {
  if (candidates.length >= githubTarget) break
  try {
    const branch = await getJson(`https://api.github.com/repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}`)
    const commit = branch.commit.sha
    const raw = await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${commit}/package.json`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!raw.ok) continue
    const pkg = await raw.json()
    const bundlePatch = pkg?.dsh?.bundle?.patch
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof bundlePatch !== 'string') continue
    candidates.push({
      source: {
        kind: 'github-sha',
        spec: `github:${repo.full_name}#${commit}`,
        commit,
      },
      repository: repo.full_name,
      url: repo.html_url,
      stars: repo.stargazers_count,
      license: repo.license?.spdx_id ?? null,
      package: {
        name: pkg.name,
        version: pkg.version,
        bundlePatch,
        scripts: typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {},
      },
    })
  } catch {
    // Discovery is best-effort. Omitted repositories are not verification failures.
  }
}

if (candidates.length < targetCount) {
  const npmSearch = await getJson('https://registry.npmjs.org/-/v1/search?text=keywords%3Adsh&size=100')
  for (const result of npmSearch.objects) {
    if (candidates.length >= targetCount) break
    const summary = result.package
    if (candidates.some(candidate => candidate.package.name === summary.name)) continue
    try {
      const escaped = summary.name.startsWith('@') ? summary.name.replace('/', '%2F') : summary.name
      const metadata = await getJson(`https://registry.npmjs.org/${escaped}/${summary.version}`)
      const bundlePatch = metadata?.dsh?.bundle?.patch
      if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string' || typeof bundlePatch !== 'string') continue
      candidates.push({
        source: {
          kind: 'npm',
          spec: `${metadata.name}@${metadata.version}`,
          integrity: metadata.dist?.integrity ?? null,
        },
        repository: typeof metadata.repository?.url === 'string' ? metadata.repository.url : null,
        url: summary.links?.npm ?? `https://www.npmjs.com/package/${metadata.name}`,
        stars: null,
        license: typeof metadata.license === 'string' ? metadata.license : null,
        package: {
          name: metadata.name,
          version: metadata.version,
          bundlePatch,
          scripts: typeof metadata.scripts === 'object' && metadata.scripts !== null ? metadata.scripts : {},
        },
      })
    } catch {
      // A malformed or unavailable npm record stays outside the candidate snapshot.
    }
  }
}

if (candidates.length < targetCount) {
  throw new Error(`discovery found ${candidates.length} valid root DSH bundles across GitHub and npm; required ${targetCount}`)
}

const snapshot = {
  schemaVersion: 1,
  source: { kind: 'github-topic+npm-search', topic: 'dsh-plugin', npmQuery: 'keywords:dsh', asOf },
  candidates: candidates.sort((a, b) => a.package.name.localeCompare(b.package.name)),
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, candidates: candidates.length })}\n`)
