import { validateHubRelease } from './hub-release-lib.mjs'

const outputDir = process.argv[2]
if (!outputDir) throw new Error('usage: validate-hub-release <release-directory> [--expected-version <version>]')
const expectedIndex = process.argv.indexOf('--expected-version')
const expectedVersion = expectedIndex === -1 ? undefined : process.argv[expectedIndex + 1]
if (expectedIndex !== -1 && !expectedVersion) throw new Error('--expected-version requires a value')
const result = await validateHubRelease(outputDir, { expectedVersion })
process.stdout.write(`${JSON.stringify(result)}\n`)
