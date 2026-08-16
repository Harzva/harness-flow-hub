import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('native home gives a direct Plugin versus Flow decision path', async () => {
  const source = await readFile('src/client/index.tsx', 'utf8')

  assert.match(source, /PLUGIN \/ 单项能力/)
  assert.match(source, /我只缺一个工具或连接/)
  assert.match(source, /插件增加一项能力/)
  assert.match(source, /onClick=\{\(\) => \{ setView\('plugins'\) \}\}/)

  assert.match(source, /FLOW \/ 完整专家方案/)
  assert.match(source, /我想直接得到一套工作环境/)
  for (const component of ['角色与边界', 'Skills', 'Plugins', 'Memory', 'Workflow', 'Permissions', '默认配置', '验收任务', '独立 Profile', 'Stack lock']) {
    assert.match(source, new RegExp(component))
  }
  assert.match(source, /onClick=\{\(\) => \{ setView\('flows'\) \}\}/)
})

test('concept choice is preview-only, keyboard-visible and responsive', async () => {
  const source = await readFile('src/client/index.tsx', 'utf8')

  assert.match(source, /这里不会立即安装/)
  assert.match(source, /来源、权限、风险和验证证据/)
  assert.match(source, /<section className="flowHubChooser" aria-labelledby="flow-hub-choose-title">/)
  assert.match(source, /\.flowHubChoice:focus-visible/)
  assert.match(source, /\.flowHubChoices,.flowHubPluginLayout/)
  assert.match(source, /@media\(max-width:650px\)\{\.flowHubShell\{position:fixed;inset:88px 16px 18px/)
  assert.doesNotMatch(source, /flowHubChoice[^>]+href=/)
  assert.doesNotMatch(source, /flowHubChoice[^>]+requestPlan/)
  assert.doesNotMatch(source, /flowHubChoice[^>]+runAction/)
})
