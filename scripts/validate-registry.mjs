import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const target = resolve(process.argv[2] ?? 'registry/generated/registry.json')
const schemaNames = [
  'plugin-record.schema.json',
  'verification-result.schema.json',
  'flow-record.schema.json',
  'registry.schema.json',
]
const schemas = await Promise.all(schemaNames.map(async name =>
  JSON.parse(await readFile(resolve('schemas', name), 'utf8')),
))
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
for (const schema of schemas) ajv.addSchema(schema)
const validate = ajv.getSchema('https://harness-flow.dev/schemas/registry.schema.json')
if (validate === undefined) throw new Error('registry schema was not registered')
const registry = JSON.parse(await readFile(target, 'utf8'))
if (!validate(registry)) {
  process.stderr.write(`${JSON.stringify({ ok: false, target, errors: validate.errors }, null, 2)}\n`)
  process.exitCode = 1
} else {
  const ids = registry.plugins.map(plugin => plugin.id)
  if (new Set(ids).size !== ids.length) throw new Error('registry contains duplicate plugin ids')
  process.stdout.write(`${JSON.stringify({ ok: true, target, plugins: ids.length, flows: registry.flows.length })}\n`)
}
