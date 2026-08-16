import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const policy = JSON.parse(await readFile(new URL('../registry/audits/flow-dependency-policy.json', import.meta.url), 'utf8'))

test('corrected Flow dependency audit separates package boot eligibility from Flow capability fit', () => {
  assert.equal(policy.packages.length, 7)
  assert.ok(policy.packages.every(item => item.hostedBootEligible === true))
  assert.equal(policy.packages.find(item => item.package === 'dsh-plugin-writing-guard').flowFit['coding-expert'], 'mismatch')
  assert.equal(policy.packages.find(item => item.package === 'dsh-frontend-tools-bridge').flowFit['ui-design-studio'], 'supporting-only')
  assert.equal(policy.packages.find(item => item.package === 'dsh-science-workbench').flowFit['research-expert'], 'primary-match')
  assert.equal(policy.packages.find(item => item.package === 'dsh-openwolf').flowFit['coding-expert'], 'primary-match-with-dsh-core')
  assert.equal(policy.packages.find(item => item.package === '@anionex/dsh-vision-toolkit').flowFit['ui-design-studio'], 'primary-match')
  assert.ok(Object.values(policy.flowCapabilityGate).every(gate => gate.passed === false))
})

test('static audit policy pins exact npm versions and SHA-512 integrity', () => {
  for (const item of policy.packages) {
    assert.match(item.version, /^\d+\.\d+\.\d+/)
    assert.match(item.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/)
    const basename = item.package.includes('/') ? item.package.split('/').at(-1) : item.package
    assert.equal(item.tarball, `https://registry.npmjs.org/${item.package}/-/${basename}-${item.version}.tgz`)
    assert.ok(item.capabilityEvidence.length > 0)
    assert.ok(item.riskEvidence.length > 0)
  }
})
