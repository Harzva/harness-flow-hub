import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('GitHub Pages is a read-only discovery surface with an explicit DSH boundary', async () => {
  const [html, script, workflow, readme, packageText] = await Promise.all([
    readFile('site/index.html', 'utf8'), readFile('site/app.js', 'utf8'), readFile('.github/workflows/pages.yml', 'utf8'),
    readFile('README.md', 'utf8'), readFile('package.json', 'utf8'),
  ])
  const packageJson = JSON.parse(packageText)
  const requiredAliases = ['dsh', 'dsh-plugin', 'dsh-flow', 'dsh-flow-hub', 'dsh-hub', 'deepseek-harness']
  assert.match(html, /核心安装流程留在 DSH 原生 UI/)
  assert.match(html, /本站不执行远程安装/)
  assert.match(html, /<title>DSH Harness Flow Hub/)
  for (const alias of requiredAliases) {
    assert.ok(packageJson.keywords.includes(alias), `package keywords must retain ${alias}`)
    assert.match(html, new RegExp(`(?:content="[^"]*|开发者搜索别名：[^<]*)${alias}`), `public page must retain ${alias}`)
    assert.match(readme, new RegExp(alias), `README must retain ${alias}`)
  }
  assert.match(html, /rel="canonical" href="https:\/\/harzva\.github\.io\/harness-flow-hub\/"/)
  assert.match(html, /NO CREDENTIALS/)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /name="referrer" content="no-referrer"/)
  assert.doesNotMatch(html, /<form/i)
  assert.match(script, /fetch\('\.\/registry\.json'/)
  assert.doesNotMatch(script, /innerHTML|localStorage|sessionStorage/)
  assert.match(workflow, /actions\/deploy-pages@v4/)
  assert.match(workflow, /registry\/generated\/registry\.json/)
  assert.match(workflow, /audit-public-site\.mjs _site/)
  assert.doesNotMatch(workflow, /cp -R site/)
})

test('public site disclosure audit uses an exact allowlist and blocks developer remarks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flow-hub-public-'))
  try {
    await mkdir(directory, { recursive: true })
    await Promise.all([
      cp('site/index.html', join(directory, 'index.html')),
      cp('site/styles.css', join(directory, 'styles.css')),
      cp('site/app.js', join(directory, 'app.js')),
      cp('registry/generated/registry.json', join(directory, 'registry.json')),
      writeFile(join(directory, '.nojekyll'), ''),
    ])
    await execFileAsync(process.execPath, ['scripts/audit-public-site.mjs', directory])
    await writeFile(join(directory, 'index.html'), '<!-- DEVELOPER NOTE: private -->')
    await assert.rejects(execFileAsync(process.execPath, ['scripts/audit-public-site.mjs', directory]), /public-disclosure-audit-failed/)
    await writeFile(join(directory, 'notes.txt'), 'should never publish')
    await assert.rejects(execFileAsync(process.execPath, ['scripts/audit-public-site.mjs', directory]), /public-file-allowlist-failed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
