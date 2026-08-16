import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCompatibility } from '../lib/compatibility.js'

const compatibleInput = {
  dshVersion: '0.1.0-rc.6',
  hubVersion: '0.0.2-m0',
  registrySchemaVersion: 1,
  flowSchemaVersions: [1, 1],
}

test('four-dimensional compatibility requires every dimension to be supported', () => {
  const result = evaluateCompatibility(compatibleInput)
  assert.equal(result.overall, 'compatible')
  assert.deepEqual(Object.fromEntries(Object.entries(result.dimensions).map(([name, value]) => [name, value.state])), {
    dsh: 'compatible', hub: 'compatible', registrySchema: 'compatible', flowSchema: 'compatible',
  })
  assert.equal(result.dimensions.dsh.supported, '>=0.1.0-rc.6 <0.2.0')
  assert.equal(result.dimensions.hub.supported, '>=0.0.2-m0 <0.1.0')
  assert.equal(result.dimensions.registrySchema.supported, '1.x')
  assert.equal(result.dimensions.flowSchema.supported, '1.x')
})

test('every incompatible dimension fails the overall gate closed', () => {
  const cases = [
    ['dsh', { dshVersion: '0.2.0' }],
    ['hub', { hubVersion: '0.1.0' }],
    ['registrySchema', { registrySchemaVersion: 2 }],
    ['flowSchema', { flowSchemaVersions: [1, 2] }],
  ]
  for (const [name, patch] of cases) {
    const result = evaluateCompatibility({ ...compatibleInput, ...patch })
    assert.equal(result.overall, 'incompatible', name)
    assert.equal(result.dimensions[name].state, 'incompatible', name)
  }
})

test('missing dimensions remain unknown and malformed metadata is incompatible', () => {
  const missing = evaluateCompatibility({ dshVersion: null, hubVersion: null, registrySchemaVersion: null, flowSchemaVersions: [] })
  assert.equal(missing.overall, 'unknown')
  assert.ok(Object.values(missing.dimensions).every(value => value.state === 'unknown'))

  const malformed = evaluateCompatibility({ ...compatibleInput, registrySchemaVersion: '1', flowSchemaVersions: [null] })
  assert.equal(malformed.overall, 'incompatible')
  assert.equal(malformed.dimensions.registrySchema.reason, 'invalid-schema-version')
  assert.equal(malformed.dimensions.flowSchema.reason, 'invalid-flow-schema-version')
})

test('incompatible takes precedence over unknown in the aggregate state', () => {
  const result = evaluateCompatibility({ ...compatibleInput, dshVersion: null, flowSchemaVersions: [2] })
  assert.equal(result.dimensions.dsh.state, 'unknown')
  assert.equal(result.dimensions.flowSchema.state, 'incompatible')
  assert.equal(result.overall, 'incompatible')
})
