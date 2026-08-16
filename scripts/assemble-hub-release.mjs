import { assembleHubRelease } from './hub-release-lib.mjs'

const result = await assembleHubRelease({ outputDir: process.argv[2] })
process.stdout.write(`${JSON.stringify({ ok: true, outputDir: result.outputDir, version: result.manifest.version, dshRange: result.manifest.compatibility.dsh.supportedRange })}\n`)
