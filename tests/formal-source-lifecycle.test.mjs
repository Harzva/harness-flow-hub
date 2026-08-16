import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

test('formal npm and tgz release paths share the complete recoverable lifecycle gate', async () => {
  const source = await readFile('scripts/verify-formal-source-lifecycle.mjs', 'utf8')
  for (const action of ["installPlan('add'", "installPlan('update'", "installPlan('remove'", 'createRollbackPlan']) {
    assert.match(source, new RegExp(action.replace(/[()']/g, value => `\\${value}`)))
  }
  assert.match(source, /kind: 'npm'/)
  assert.match(source, /kind: 'tgz'/)
  assert.match(source, /failAt: 'health'/)
  assert.match(source, /failed update changed manifest/)
  assert.match(source, /failed update changed lockfile/)
  assert.match(source, /userProfileTouched: false/)
  assert.match(source, /privatePathsRecorded: false/)

  const workflow = parseYaml(await readFile('.github/workflows/registry.yml', 'utf8'))
  const job = workflow.jobs['install-transaction']
  const lifecycle = job.steps.find(step => step.name === 'Verify npm and tgz full recoverable lifecycle')
  assert.equal(lifecycle.run, 'pnpm run transaction:verify-formal-sources')
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.match(upload.with.path, /m2-formal-source-lifecycle-2026-08-17\.json/)
})
