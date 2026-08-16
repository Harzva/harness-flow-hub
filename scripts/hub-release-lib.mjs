import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { valid, validRange, satisfies } from 'semver'
import { validateDshMatrixConfig } from './dsh-matrix-lib.mjs'

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value)
    && !value.split(/[\\/]/).includes('..') && !/^[A-Za-z]:/.test(value)
}

function fileRecord(path, bytes) {
  return { path: path.replaceAll('\\', '/'), sha256: digest(bytes), bytes: bytes.byteLength }
}

function artifactFilename(packageName, version) {
  return `${packageName.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
}

export function validateHubReleaseSource(packageManifest, matrix) {
  validateDshMatrixConfig(matrix)
  if (packageManifest?.name !== '@harness-flow/dsh-flow-hub') throw new Error('hub-release-package-name-mismatch')
  if (valid(packageManifest.version) === null) throw new Error('hub-release-version-invalid')
  if (packageManifest.version !== matrix.hubVersion) throw new Error('hub-release-version-matrix-mismatch')
  const declared = packageManifest.dsh?.compatibility
  if (declared?.dsh !== matrix.supportedRange) throw new Error('hub-release-dsh-range-mismatch')
  if (declared.registrySchema !== 1 || declared.flowSchema !== 1) throw new Error('hub-release-schema-range-mismatch')
  if (validRange(declared.dsh) === null) throw new Error('hub-release-dsh-range-invalid')
  const verifiedVersions = matrix.entries.filter(entry => entry.expected === 'compatible').map(entry => entry.version)
  if (verifiedVersions.length === 0 || !verifiedVersions.every(version => satisfies(version, declared.dsh, { includePrerelease: true }))) {
    throw new Error('hub-release-verified-version-outside-range')
  }
  if (!Array.isArray(packageManifest.files) || !packageManifest.files.includes('compatibility/*.json')) {
    throw new Error('hub-release-package-omits-compatibility')
  }
  return { verifiedVersions }
}

export async function assembleHubRelease(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? '.')
  const packageManifest = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'))
  const matrixPath = resolve(projectRoot, options.matrixPath ?? 'compatibility/dsh-matrix.json')
  const matrixBytes = await readFile(matrixPath)
  const matrix = JSON.parse(matrixBytes.toString('utf8'))
  const { verifiedVersions } = validateHubReleaseSource(packageManifest, matrix)
  const artifactPath = resolve(projectRoot, options.artifactPath ?? `artifacts/${artifactFilename(packageManifest.name, packageManifest.version)}`)
  const artifactBytes = await readFile(artifactPath)
  const outputDir = resolve(options.outputDir ?? `dist/hub/${packageManifest.version}`)
  if (outputDir === projectRoot || outputDir === dirname(outputDir) || basename(outputDir).length === 0) throw new Error('unsafe-hub-release-output-directory')

  const artifactTarget = `packages/${basename(artifactPath)}`
  const matrixTarget = 'compatibility/dsh-matrix.json'
  const notesTarget = 'RELEASE-NOTES.md'
  const notes = [
    `# Harness Flow Hub ${packageManifest.version}`,
    '',
    `Package: \`${packageManifest.name}\``,
    `Supported DSH: \`${matrix.supportedRange}\``,
    `Verified DSH versions: ${verifiedVersions.map(version => `\`${version}\``).join(', ')}`,
    `Validated platforms: ${matrix.platforms.join(', ')}`,
    '',
    'Install through the official DSH plugin command. The compatibility range is enforced by the Hub Bootstrap and release validator.',
    '',
  ].join('\n')
  const notesBytes = Buffer.from(notes)

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(resolve(outputDir, dirname(artifactTarget)), { recursive: true })
  await mkdir(resolve(outputDir, dirname(matrixTarget)), { recursive: true })
  await copyFile(artifactPath, resolve(outputDir, artifactTarget))
  await copyFile(matrixPath, resolve(outputDir, matrixTarget))
  await writeFile(resolve(outputDir, notesTarget), notesBytes)

  const manifest = {
    schemaVersion: 1,
    packageName: packageManifest.name,
    version: packageManifest.version,
    sourceDate: matrix.observedAt,
    compatibility: {
      dsh: { supportedRange: matrix.supportedRange, verifiedVersions },
      registrySchema: packageManifest.dsh.compatibility.registrySchema,
      flowSchema: packageManifest.dsh.compatibility.flowSchema,
      platforms: matrix.platforms,
    },
    artifact: fileRecord(artifactTarget, artifactBytes),
    matrix: fileRecord(matrixTarget, matrixBytes),
    releaseNotes: fileRecord(notesTarget, notesBytes),
  }
  await writeFile(resolve(outputDir, 'hub-release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { outputDir, manifest }
}

export async function validateHubRelease(outputDirArg, options = {}) {
  const outputDir = resolve(outputDirArg)
  const manifest = JSON.parse(await readFile(resolve(outputDir, 'hub-release.json'), 'utf8'))
  const projectRoot = resolve(options.projectRoot ?? '.')
  const schema = JSON.parse(await readFile(resolve(projectRoot, 'schemas/hub-release-manifest.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  if (!validate(manifest)) throw new Error(`invalid Hub release manifest: ${ajv.errorsText(validate.errors)}`)

  for (const record of [manifest.artifact, manifest.matrix, manifest.releaseNotes]) {
    if (!safeRelativePath(record.path)) throw new Error(`unsafe Hub release path:${record.path}`)
    const bytes = await readFile(resolve(outputDir, record.path))
    if (bytes.byteLength !== record.bytes) throw new Error(`Hub release size mismatch:${record.path}`)
    if (digest(bytes) !== record.sha256) throw new Error(`Hub release hash mismatch:${record.path}`)
  }
  const matrix = JSON.parse(await readFile(resolve(outputDir, manifest.matrix.path), 'utf8'))
  const packageManifest = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'))
  const { verifiedVersions } = validateHubReleaseSource(packageManifest, matrix)
  if (manifest.version !== packageManifest.version || manifest.version !== matrix.hubVersion) throw new Error('Hub release version drift')
  if (manifest.compatibility.dsh.supportedRange !== matrix.supportedRange) throw new Error('Hub release DSH range drift')
  if (JSON.stringify(manifest.compatibility.dsh.verifiedVersions) !== JSON.stringify(verifiedVersions)) throw new Error('Hub release verified versions drift')
  if (JSON.stringify(manifest.compatibility.platforms) !== JSON.stringify(matrix.platforms)) throw new Error('Hub release platform drift')
  if (options.expectedVersion !== undefined && options.expectedVersion !== manifest.version) throw new Error(`Hub release tag version mismatch:${options.expectedVersion}:${manifest.version}`)
  const notes = await readFile(resolve(outputDir, manifest.releaseNotes.path), 'utf8')
  if (!notes.includes(`Supported DSH: \`${matrix.supportedRange}\``)) throw new Error('Hub release notes omit DSH range')
  return { ok: true, packageName: manifest.packageName, version: manifest.version, dshRange: matrix.supportedRange, verifiedVersions }
}
