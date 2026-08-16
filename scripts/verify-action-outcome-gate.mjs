import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { summarizeActionOutcome } from '../lib/action-outcome.js'

const output = resolve(process.argv[2] ?? 'evidence/m2-action-outcome-clarity-2026-08-17.json')
const client = await readFile(resolve('src/client/index.tsx'), 'utf8')
const requireTrue = (condition, message) => { if (!condition) throw new Error(message) }

const cases = {
  success: summarizeActionOutcome({ ok: true, action: 'update', profile: 'web', phases: [{ phase: 'health', status: 'passed' }] }),
  rolledBack: summarizeActionOutcome({
    ok: false, action: 'update', profile: 'web', error: 'injected-failure:health',
    phases: [{ phase: 'health', status: 'failed' }, { phase: 'rollback', status: 'passed' }],
  }),
  recoveryRequired: summarizeActionOutcome({
    ok: false, action: 'remove', profile: 'web', error: 'final-profile-relink-failed:1',
    phases: [{ phase: 'relink', status: 'failed' }, { phase: 'rollback', status: 'failed' }],
  }),
  unknown: summarizeActionOutcome({ ok: false, action: 'add', error: 'ENOENT PRIVATE_PATH_SENTINEL' }),
}

requireTrue(cases.success.state === 'success' && cases.success.taskLabel === '成功', 'success outcome drift')
requireTrue(cases.rolledBack.state === 'rolled-back' && cases.rolledBack.taskLabel === '已回滚', 'verified rollback outcome drift')
requireTrue(cases.recoveryRequired.state === 'recovery-required' && cases.recoveryRequired.taskLabel === '需要恢复', 'failed rollback was not escalated')
requireTrue(cases.unknown.state === 'unknown' && cases.unknown.taskLabel === '状态待确认', 'unknown result was overclaimed')
requireTrue(!JSON.stringify(cases).includes('PRIVATE_PATH_SENTINEL'), 'raw diagnostic leaked into user outcome')
for (const label of ['发生了什么', '是否已回滚', '下一步', '查看 Profiles']) requireTrue(client.includes(label), `native UI missing outcome field:${label}`)
requireTrue(client.includes('summarizeActionOutcome(task).taskLabel'), 'task history does not use verified outcome state')
requireTrue(!client.includes("task.ok ? '成功' : '已回滚'"), 'task history still overclaims every failure as rolled back')

const report = {
  schemaVersion: 1,
  date: '2026-08-17',
  subject: 'DSH native action outcome clarity and recovery guidance gate',
  environment: { os: process.platform, arch: process.arch, node: process.version },
  commands: ['pnpm run ui:verify-action-outcomes', 'pnpm check', 'pnpm run site:audit'],
  checks: {
    success: { status: 'passed', state: cases.success.state, taskLabel: cases.success.taskLabel },
    verifiedRollback: { status: 'passed', state: cases.rolledBack.state, taskLabel: cases.rolledBack.taskLabel },
    failedRollback: { status: 'passed', state: cases.recoveryRequired.state, taskLabel: cases.recoveryRequired.taskLabel },
    unknownResult: { status: 'passed', state: cases.unknown.state, taskLabel: cases.unknown.taskLabel },
    threeQuestions: { status: 'passed', labels: ['发生了什么', '是否已回滚', '下一步'] },
    inDshRecovery: { status: 'passed', action: '查看 Profiles' },
    rawDiagnosticRedaction: { status: 'passed' },
  },
  privacy: { credentialsCaptured: false, privatePathsRecorded: false, rawDiagnosticsPersisted: false },
  browserWriteEvidence: { status: 'not-run', reason: 'Requires action-time user confirmation for failure injection in the browser.' },
  result: 'passed-with-browser-write-gate-open',
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output, checks: Object.keys(report.checks).length, result: report.result })}\n`)
