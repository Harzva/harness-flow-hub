import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('GitHub Pages is a read-only discovery surface with an explicit DSH boundary', async () => {
  const [html, script, workflow] = await Promise.all([
    readFile('site/index.html', 'utf8'), readFile('site/app.js', 'utf8'), readFile('.github/workflows/pages.yml', 'utf8'),
  ])
  assert.match(html, /核心安装流程留在 DSH 原生 UI/)
  assert.match(html, /本站不执行远程安装/)
  assert.match(html, /NO CREDENTIALS/)
  assert.doesNotMatch(html, /<form/i)
  assert.match(script, /fetch\('\.\/registry\.json'/)
  assert.doesNotMatch(script, /innerHTML|localStorage|sessionStorage/)
  assert.match(workflow, /actions\/deploy-pages@v4/)
  assert.match(workflow, /registry\/generated\/registry\.json/)
})
