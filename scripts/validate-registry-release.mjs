import { validateRegistryRelease } from './registry-release-lib.mjs'

const outputDir = process.argv[2]
if (!outputDir) throw new Error('usage: validate-registry-release <release-directory> [--allow-unsigned]')
const result = await validateRegistryRelease(outputDir, { allowUnsigned: process.argv.includes('--allow-unsigned') })
process.stdout.write(`${JSON.stringify(result)}\n`)

