import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('native Flow Hub exposes keyboard, focus, status and responsive accessibility contracts', async () => {
  const source = await readFile('src/client/index.tsx', 'utf8')
  assert.match(source, /role="dialog" aria-labelledby=/)
  assert.match(source, /event\.key === 'Escape'/)
  assert.match(source, /event\.stopPropagation\(\)/)
  assert.match(source, /dialogRef\.current\?\.focus\(\)/)
  assert.match(source, /planWasOpenRef/)
  assert.match(source, /window\.setTimeout\(\(\) => \{ target\?\.focus\(\) \}, 50\)/)
  assert.match(source, /aria-current=\{view === item\.id \? 'page'/)
  assert.doesNotMatch(source, /aria-selected=\{view === item\.id\}/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /role=\{result\.ok \? 'status' : 'alert'\}/)
  assert.match(source, /aria-busy=\{running !== null\}/)
  assert.match(source, /focus-visible/)
  assert.match(source, /min-height:44px/)
  assert.match(source, /@media\(prefers-reduced-motion:no-preference\)/)
  assert.match(source, /@container\(max-width:760px\)/)
})
