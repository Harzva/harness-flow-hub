import { assembleRegistryRelease } from './registry-release-lib.mjs'

const registryPath = process.argv[2] ?? 'registry/generated/registry.json'
const outputDir = process.argv[3]?.startsWith('--') ? undefined : process.argv[3]
function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const signaturePath = option('--signature')
const publicKeyPath = option('--public-key')
const now = option('--now')
const result = await assembleRegistryRelease({
  registryPath,
  ...(outputDir ? { outputDir } : {}),
  ...(signaturePath ? { signaturePath } : {}),
  ...(publicKeyPath ? { publicKeyPath } : {}),
  ...(now ? { now } : {}),
})
process.stdout.write(`${JSON.stringify({ ok: true, output: result.outputDir, status: result.manifest.status, files: result.manifest.files.length })}\n`)
