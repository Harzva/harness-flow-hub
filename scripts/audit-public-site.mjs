import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '_site')
const allowedFiles = new Set(['.nojekyll', 'app.js', 'index.html', 'registry.json', 'styles.css'])
const textualFiles = new Set(['app.js', 'index.html', 'registry.json', 'styles.css'])

const globalRules = [
  ['developer-remark', /\b(?:TODO|FIXME|HACK|XXX)\b|INTERNAL[ -]ONLY|DEVELOPER[ -]NOTE|开发者备注|内部备注/i],
  ['private-path', /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/|Documents[\\/]Codex|work[\\/]reference)/i],
  ['source-map-reference', /sourceMappingURL/i],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-value', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i],
  ['known-secret-shape', /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/],
]

const fileRules = {
  'index.html': [
    ['html-comment', /<!--[\s\S]*?-->/],
    ['loopback-address', /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i],
  ],
  'app.js': [
    ['javascript-line-comment', /^\s*\/\//m],
    ['javascript-block-comment', /\/\*[\s\S]*?\*\//],
    ['debug-statement', /\b(?:console\.(?:debug|log)|debugger)\b/],
    ['loopback-address', /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i],
  ],
  'styles.css': [
    ['css-comment', /\/\*[\s\S]*?\*\//],
    ['loopback-address', /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i],
  ],
}

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

const files = await walk(root)
const relativeFiles = files.map(file => relative(root, file).replaceAll('\\', '/')).sort()
const unexpected = relativeFiles.filter(file => !allowedFiles.has(file))
const missing = [...allowedFiles].filter(file => !relativeFiles.includes(file))
if (unexpected.length || missing.length) {
  throw new Error(`public-file-allowlist-failed unexpected=${unexpected.join(',') || 'none'} missing=${missing.join(',') || 'none'}`)
}

const findings = []
for (const file of files) {
  const name = basename(file)
  if (!textualFiles.has(name)) continue
  const metadata = await stat(file)
  if (metadata.size > 2 * 1024 * 1024) findings.push(`${name}:oversized-public-file`)
  const text = await readFile(file, 'utf8')
  for (const [rule, pattern] of [...globalRules, ...(fileRules[name] ?? [])]) {
    if (pattern.test(text)) findings.push(`${name}:${rule}`)
  }
}

if (findings.length) throw new Error(`public-disclosure-audit-failed ${findings.join(' ')}`)
process.stdout.write(JSON.stringify({ ok: true, root, files: relativeFiles, rules: globalRules.length + 7 }) + '\n')
