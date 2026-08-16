import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { verifyRegistrySignature } from './registry-signature-lib.mjs'

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function filesBelow(root, current = root) {
  const output = []
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(root, path))
    else if (entry.isFile()) output.push(relative(root, path).replaceAll('\\', '/'))
  }
  return output
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value)
    && !value.split(/[\\/]/).includes('..') && !/^[A-Za-z]:/.test(value)
}

async function copySource(projectRoot, outputDir, targetPath, sourcePath) {
  if (!safeRelativePath(targetPath)) throw new Error(`unsafe release target: ${targetPath}`)
  const source = resolve(projectRoot, sourcePath)
  const sourceRelative = relative(projectRoot, source)
  if (sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) throw new Error(`release source escapes project: ${sourcePath}`)
  const target = resolve(outputDir, targetPath)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

export async function assembleRegistryRelease(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? '.')
  const registryPath = resolve(projectRoot, options.registryPath ?? 'registry/generated/registry.json')
  const registryText = await readFile(registryPath, 'utf8')
  const registry = JSON.parse(registryText)
  const outputDir = resolve(options.outputDir ?? `dist/registry/${registry.registryVersion}`)
  if (outputDir === projectRoot || outputDir === dirname(outputDir) || basename(outputDir).length === 0) {
    throw new Error(`unsafe release output directory: ${outputDir}`)
  }
  if ((options.signaturePath === undefined) !== (options.publicKeyPath === undefined)) {
    throw new Error('signature and public key must be supplied together')
  }

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  const sources = new Map([
    ['registry/registry.json', relative(projectRoot, registryPath)],
    ['registry/revocations.json', 'registry/revocations.json'],
    ['registry/platform-support.json', 'registry/platform-support.json'],
    ['registry/discovery/github-topic-2026-08-16.json', 'registry/discovery/github-topic-2026-08-16.json'],
    ['registry/audits/candidates-2026-08-16.json', 'registry/audits/candidates-2026-08-16.json'],
    ['evidence/m1-registry-alpha-2026-08-16.json', 'evidence/m1-registry-alpha-2026-08-16.json'],
  ])
  for (const name of (await readdir(resolve(projectRoot, 'schemas'))).filter(name => name.endsWith('.json')).sort()) {
    sources.set(`schemas/${name}`, `schemas/${name}`)
  }
  for (const plugin of registry.plugins) {
    for (const evidence of plugin.verification.evidence ?? []) {
      if (/^https:\/\//.test(evidence)) continue
      if (!safeRelativePath(evidence)) throw new Error(`unsafe Registry evidence path: ${evidence}`)
      sources.set(evidence.replaceAll('\\', '/'), evidence)
    }
  }

  let signaturePresent = false
  let signatureSource
  let publicKeySource
  if (options.signaturePath !== undefined) {
    signatureSource = resolve(options.signaturePath)
    publicKeySource = resolve(options.publicKeyPath)
    const envelopeText = await readFile(signatureSource, 'utf8')
    const envelope = JSON.parse(envelopeText)
    const publicKey = await readFile(publicKeySource, 'utf8')
    const revocations = JSON.parse(await readFile(resolve(projectRoot, 'registry/revocations.json'), 'utf8'))
    const result = verifyRegistrySignature(registryText, envelope, publicKey, { revocations, now: options.now })
    if (!result.ok) throw new Error(`Registry signature is not publishable: ${result.reason}`)
    signaturePresent = true
  }

  for (const [target, source] of [...sources.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await copySource(projectRoot, outputDir, target, source)
  }
  if (signaturePresent && signatureSource !== undefined && publicKeySource !== undefined) {
    await mkdir(resolve(outputDir, 'registry'), { recursive: true })
    await mkdir(resolve(outputDir, 'keys'), { recursive: true })
    await copyFile(signatureSource, resolve(outputDir, 'registry/registry.signature.json'))
    await copyFile(publicKeySource, resolve(outputDir, 'keys/registry-ed25519-public.pem'))
  }
  const files = []
  for (const path of await filesBelow(outputDir)) {
    const bytes = await readFile(resolve(outputDir, path))
    files.push({ path, sha256: digest(bytes), bytes: bytes.byteLength })
  }
  const manifest = {
    schemaVersion: 1,
    registryVersion: registry.registryVersion,
    status: signaturePresent ? 'signed' : 'candidate',
    sourceDate: registry.generatedFrom.asOf,
    registrySha256: digest(Buffer.from(registryText)),
    signatureRequired: true,
    signaturePresent,
    files,
  }
  await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { outputDir, manifest }
}

export async function validateRegistryRelease(outputDirArg, options = {}) {
  const outputDir = resolve(outputDirArg)
  const manifest = JSON.parse(await readFile(resolve(outputDir, 'manifest.json'), 'utf8'))
  const schema = JSON.parse(await readFile(resolve(options.projectRoot ?? '.', 'schemas/registry-release-manifest.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  if (!validate(manifest)) throw new Error(`invalid release manifest: ${ajv.errorsText(validate.errors)}`)
  const actualFiles = (await filesBelow(outputDir)).filter(path => path !== 'manifest.json')
  const declaredFiles = manifest.files.map(file => file.path)
  if (new Set(declaredFiles).size !== declaredFiles.length) throw new Error('release manifest repeats file paths')
  if (JSON.stringify(actualFiles) !== JSON.stringify([...declaredFiles].sort())) throw new Error('release files do not match manifest')
  for (const file of manifest.files) {
    if (!safeRelativePath(file.path)) throw new Error(`unsafe release file path: ${file.path}`)
    const bytes = await readFile(resolve(outputDir, file.path))
    if (bytes.byteLength !== file.bytes) throw new Error(`release file size mismatch: ${file.path}`)
    if (digest(bytes) !== file.sha256) throw new Error(`release file hash mismatch: ${file.path}`)
  }
  const registryText = await readFile(resolve(outputDir, 'registry/registry.json'), 'utf8')
  if (digest(Buffer.from(registryText)) !== manifest.registrySha256) throw new Error('release Registry hash mismatch')
  if (manifest.signatureRequired && !manifest.signaturePresent && !options.allowUnsigned) {
    throw new Error('unsigned Registry release is not publishable')
  }
  if (manifest.signaturePresent) {
    const envelope = JSON.parse(await readFile(resolve(outputDir, 'registry/registry.signature.json'), 'utf8'))
    const publicKey = await readFile(resolve(outputDir, 'keys/registry-ed25519-public.pem'), 'utf8')
    const revocations = JSON.parse(await readFile(resolve(outputDir, 'registry/revocations.json'), 'utf8'))
    const result = verifyRegistrySignature(registryText, envelope, publicKey, { revocations, now: options.now })
    if (!result.ok) throw new Error(`release Registry signature failed: ${result.reason}`)
  }
  return { ok: true, files: manifest.files.length, status: manifest.status, registryVersion: manifest.registryVersion }
}
