import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('GitHub Pages is a read-only discovery surface with an explicit DSH boundary', async () => {
  const [html, script, workflow] = await Promise.all([
    readFile('site/index.html', 'utf8'), readFile('site/app.js', 'utf8'), readFile('.github/workflows/pages.yml', 'utf8'),
  ])
  assert.match(html, /核心安装流程留在 DSH 原生 UI/)
  assert.match(html, /本站不执行远程安装/)
  assert.match(html, /<title>DSH Harness Flow Hub/)
  assert.match(html, /name="keywords" content="DSH, dsh-plugin, dsh-flow, dsh-flow-hub, dsh-hub, DeepSeek Harness, Harness Flow, Harness Flow Hub, Agent Stack, plugin registry"/)
  assert.match(html, /开发者搜索别名：DSH Flow Hub · dsh-flow-hub · dsh-plugin · DeepSeek Harness/)
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
