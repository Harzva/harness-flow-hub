import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeActionOutcome } from '../lib/action-outcome.js'

test('successful action explains completion and next inspection step', () => {
  const outcome = summarizeActionOutcome({ ok: true, action: 'update', profile: 'web', phases: [{ phase: 'health', status: 'passed' }] })
  assert.equal(outcome.state, 'success')
  assert.equal(outcome.taskLabel, '成功')
  assert.match(outcome.happened, /Profile web.*更新.*健康检查/)
  assert.match(outcome.rollback, /无需回滚/)
  assert.match(outcome.next, /Profiles/)
})

test('failed action distinguishes a verified rollback from the failed phase', () => {
  const outcome = summarizeActionOutcome({
    ok: false,
    action: 'update',
    profile: 'web',
    error: 'injected-failure:health',
    phases: [
      { phase: 'health', status: 'failed', detail: 'injected-failure:health' },
      { phase: 'rollback', status: 'passed', detail: 'restored=test' },
    ],
  })
  assert.equal(outcome.state, 'rolled-back')
  assert.equal(outcome.taskLabel, '已回滚')
  assert.match(outcome.happened, /健康检查/)
  assert.match(outcome.rollback, /自动回滚已通过/)
  assert.match(outcome.next, /重新生成计划/)
})

test('failed rollback requires recovery and never claims success', () => {
  const outcome = summarizeActionOutcome({
    ok: false,
    action: 'remove',
    profile: 'web',
    error: 'final-profile-relink-failed:1',
    phases: [
      { phase: 'relink', status: 'failed' },
      { phase: 'rollback', status: 'failed', detail: 'restore-failed' },
    ],
  })
  assert.equal(outcome.state, 'recovery-required')
  assert.equal(outcome.taskLabel, '需要恢复')
  assert.match(outcome.rollback, /不能假设/)
  assert.match(outcome.next, /不要继续修改.*Profiles.*CLI 救援/)
  assert.doesNotMatch(outcome.title, /已恢复|已回滚/)
  assert.notEqual(outcome.taskLabel, '已回滚')
})

test('missing transaction phases stays unknown and redacts raw private paths', () => {
  const outcome = summarizeActionOutcome({ ok: false, action: 'add', error: 'ENOENT C:\\Users\\private\\secret.txt' })
  assert.equal(outcome.state, 'unknown')
  assert.equal(outcome.taskLabel, '状态待确认')
  assert.match(outcome.rollback, /不能假设已经恢复/)
  assert.doesNotMatch(JSON.stringify(outcome), /C:\\Users|secret\.txt|ENOENT/)
})
