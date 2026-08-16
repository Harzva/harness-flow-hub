import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { signRegistry } from './registry-signature-lib.mjs'

const [registryArg, privateKeyArg, outputArg, keyId, expiresAt] = process.argv.slice(2)
if (![registryArg, privateKeyArg, outputArg, keyId, expiresAt].every(Boolean)) {
  throw new Error('usage: sign-registry <registry.json> <private-key.pem> <signature.json> <key-id> <expires-at>')
}
const registryText = await readFile(resolve(registryArg), 'utf8')
const privateKey = await readFile(resolve(privateKeyArg), 'utf8')
const envelope = signRegistry(registryText, privateKey, { keyId, createdAt: new Date(), expiresAt })
await writeFile(resolve(outputArg), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ ok: true, output: resolve(outputArg), keyId, expiresAt: envelope.expiresAt })}\n`)

