const state = { registry: null, filter: 'all', query: '', selected: null }
const $ = selector => document.querySelector(selector)
const labels = { passed: '通过', failed: '失败', stale: '过期', unverified: '待验证', unknown: '未知' }

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function publicSource(plugin) {
  if (plugin.source?.kind === 'github-sha' && plugin.source.commit) return `GitHub · ${plugin.source.commit.slice(0, 12)}`
  if (plugin.source?.kind === 'npm') return `npm · ${plugin.version}`
  return plugin.source?.kind ?? '来源未知'
}

function sourceUrl(plugin) {
  const match = /^github:([^#]+)#[a-f0-9]{40}$/.exec(plugin.source?.spec ?? '')
  return match ? `https://github.com/${match[1]}` : null
}

function normalizedState(plugin) {
  const value = plugin.verification?.state ?? 'unknown'
  return value === 'unknown' ? 'unverified' : value
}

function filteredPlugins() {
  if (!state.registry) return []
  const needle = state.query.trim().toLowerCase()
  return state.registry.plugins.filter(plugin => {
    const status = normalizedState(plugin)
    const filterMatch = state.filter === 'all' || status === state.filter
    const haystack = [plugin.package, plugin.id, plugin.license, plugin.source?.spec].filter(Boolean).join(' ').toLowerCase()
    return filterMatch && (!needle || haystack.includes(needle))
  })
}

function renderMetrics() {
  const plugins = state.registry?.plugins ?? []
  const count = value => plugins.filter(plugin => normalizedState(plugin) === value).length
  $('#metric-total').textContent = String(plugins.length)
  $('#metric-passed').textContent = String(count('passed'))
  $('#metric-failed').textContent = String(count('failed'))
  $('#metric-version').textContent = state.registry?.registryVersion ?? '—'
  $('#count-all').textContent = String(plugins.length)
  $('#count-passed').textContent = String(count('passed'))
  $('#count-failed').textContent = String(count('failed'))
  $('#count-unverified').textContent = String(count('unverified'))
}

function renderInspector(plugin) {
  const inspector = $('#plugin-inspector')
  inspector.replaceChildren()
  inspector.append(element('p', 'inspector-index', `DETAIL / ${plugin.id.toUpperCase()}`))
  inspector.append(element('div', `state state--${normalizedState(plugin)}`, labels[plugin.verification?.state] ?? '未知'))
  inspector.append(element('h3', '', plugin.package))
  inspector.append(element('p', '', `Registry 只展示已记录事实；验证失败不会被隐藏。`))
  const list = element('dl', 'inspector-grid')
  const rows = [
    ['版本', plugin.version], ['验证', labels[plugin.verification?.state] ?? '未知'],
    ['验证时间', plugin.verification?.verifiedAt ?? '尚无运行证据'],
    ['环境', plugin.verification?.environment ? [plugin.verification.environment.os, plugin.verification.environment.arch, plugin.verification.environment.node].join(' · ') : '尚无运行证据'],
    ['DSH 版本', plugin.verification?.dshVersion ?? '尚无运行证据'],
    ['来源', publicSource(plugin)], ['许可证', plugin.license ?? '未披露'],
    ['脚本', Object.keys(plugin.lifecycleScripts ?? {}).join('、') || '无披露脚本'],
    ['权限', (plugin.permissions ?? []).join('、') || '未声明额外权限'],
    ['凭据', (plugin.credentials ?? []).join('、') || '未声明凭据需求'],
  ]
  for (const [term, description] of rows) { list.append(element('dt', '', term), element('dd', '', description)) }
  inspector.append(list)
  const url = sourceUrl(plugin)
  const evidenceUrl = plugin.verification?.evidence?.find(item => /^https:\/\/github\.com\/Harzva\/harness-flow-hub\/blob\/registry-v/.test(item))
  if (url || evidenceUrl) {
    const actions = element('div', 'inspector-actions')
    if (evidenceUrl) {
      const evidenceLink = element('a', '', '查看验证证据 ↗')
      evidenceLink.href = evidenceUrl; evidenceLink.target = '_blank'; evidenceLink.rel = 'noopener noreferrer'
      actions.append(evidenceLink)
    }
    if (url) {
      const link = element('a', '', '查看源码 ↗')
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
      actions.append(link)
    }
    inspector.append(actions)
  }
}

function selectPlugin(plugin) {
  state.selected = plugin.id
  document.querySelectorAll('.plugin-row').forEach(row => row.classList.toggle('is-selected', row.dataset.id === plugin.id))
  renderInspector(plugin)
}

function renderLedger() {
  const ledger = $('#plugin-ledger')
  ledger.replaceChildren()
  const plugins = filteredPlugins()
  $('#result-count').textContent = `${plugins.length} 条记录 · ${state.filter === 'all' ? '全部状态' : labels[state.filter]}`
  plugins.forEach((plugin, index) => {
    const row = element('button', 'plugin-row')
    row.type = 'button'; row.dataset.id = plugin.id
    row.setAttribute('aria-label', `查看 ${plugin.package} 详情`)
    row.append(element('span', 'plugin-row__index', String(index + 1).padStart(2, '0')))
    const identity = element('span')
    identity.append(element('strong', '', plugin.package), element('small', '', `${plugin.version} · ${plugin.license ?? '许可证未知'} · ${publicSource(plugin)}`))
    row.append(identity, element('span', `state state--${normalizedState(plugin)}`, labels[plugin.verification?.state] ?? '未知'))
    row.addEventListener('click', () => selectPlugin(plugin))
    ledger.append(row)
  })
  const selected = plugins.find(plugin => plugin.id === state.selected) ?? plugins[0]
  if (selected) selectPlugin(selected)
  else {
    const inspector = $('#plugin-inspector'); inspector.replaceChildren(element('p', 'inspector-index', 'DETAIL / —'), element('h3', '', '没有匹配记录'), element('p', '', '调整搜索词或验证状态筛选。'))
  }
}

async function boot() {
  try {
    const response = await fetch('./registry.json', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const registry = await response.json()
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) throw new Error('invalid Registry')
    state.registry = registry
    renderMetrics(); renderLedger()
  } catch {
    $('#registry-error').hidden = false
    $('#result-count').textContent = 'Registry 不可达'
  }
}

$('#registry-search').addEventListener('input', event => { state.query = event.target.value; renderLedger() })
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach(item => item.classList.remove('is-active'))
  button.classList.add('is-active'); state.filter = button.dataset.filter; renderLedger()
}))
boot()
