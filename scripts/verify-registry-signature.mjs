import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRegistrySignature } from './registry-signature-lib.mjs'

const [registryArg, signatureArg, publicKeyArg, revocationsArg = 'registry/revocations.json'] = process.argv.slice(2)
if (![registryArg, signatureArg, publicKeyArg].every(Boolean)) {
  throw new Error('usage: verify-registry-signature <registry.json> <signature.json> <public-key.pem> [revocations.json]')
}
const registryText = await readFile(resolve(registryArg), 'utf8')
const envelope = JSON.parse(await readFile(resolve(signatureArg), 'utf8'))
const publicKey = await readFile(resolve(publicKeyArg), 'utf8')
const revocations = JSON.parse(await readFile(resolve(revocationsArg), 'utf8'))
const result = verifyRegistrySignature(registryText, envelope, publicKey, { revocations })
process.stdout.write(`${JSON.stringify(result)}\n`)
if (!result.ok) process.exitCode = 1

