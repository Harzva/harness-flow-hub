import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { auditCandidateMetadata, entryUrl } from './candidate-audit-lib.mjs'

const input = resolve(process.argv[2] ?? 'registry/discovery/github-topic-2026-08-16.json')
const output = resolve(process.argv[3] ?? 'registry/audits/candidates-2026-08-16.json')
const snapshot = JSON.parse(await readFile(input, 'utf8'))

async function checkEntry(candidate) {
  const url = entryUrl(candidate)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'harness-flow-hub-registry-alpha' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    const body = response.ok ? await response.text() : ''
    return {
      id: 'bundle-entry-exists',
      status: response.ok && body.trim().length > 0 ? 'passed' : 'failed',
      detail: `${response.status} ${url}`,
    }
  } catch (error) {
    return { id: 'bundle-entry-exists', status: 'failed', detail: `${error.message} ${url}` }
  }
}

const records = []
for (const candidate of snapshot.candidates) {
  const checks = auditCandidateMetadata(candidate)
  checks.push(await checkEntry(candidate))
  records.push({
    subject: candidate.package.name,
    source: candidate.source.spec,
    status: checks.every(item => item.status === 'passed') ? 'passed' : 'failed',
    checks,
  })
}

const report = {
  schemaVersion: 1,
  auditedAt: new Date().toISOString(),
  input: 'registry/discovery/github-topic-2026-08-16.json',
  candidates: records.length,
  passed: records.filter(record => record.status === 'passed').length,
  failed: records.filter(record => record.status === 'failed').length,
  records,
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: report.failed === 0, output, candidates: report.candidates, passed: report.passed, failed: report.failed })}\n`)
if (report.failed > 0) process.exitCode = 1

