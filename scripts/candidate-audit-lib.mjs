const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA_PATTERN = /^[a-f0-9]{40}$/
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/

function check(id, passed, detail) {
  return { id, status: passed ? 'passed' : 'failed', ...(detail ? { detail } : {}) }
}

export function entryUrl(candidate) {
  const patch = candidate.package.bundlePatch.replace(/^\.\//, '')
  if (candidate.source.kind === 'github-sha') {
    return `https://raw.githubusercontent.com/${candidate.repository}/${candidate.source.commit}/${patch}`
  }
  if (candidate.source.kind === 'npm') {
    return `https://unpkg.com/${candidate.package.name}@${candidate.package.version}/${patch}`
  }
  throw new Error(`unsupported candidate source: ${candidate.source.kind}`)
}

export function auditCandidateMetadata(candidate) {
  const scripts = candidate.package?.scripts
  const patch = candidate.package?.bundlePatch
  const safePatch = typeof patch === 'string'
    && patch.length > 0
    && !patch.startsWith('/')
    && !patch.startsWith('\\')
    && !patch.split(/[\\/]/).includes('..')
    && /\.ya?ml$/i.test(patch)
  const sourcePinned = candidate.source?.kind === 'github-sha'
    ? SHA_PATTERN.test(candidate.source.commit ?? '')
      && candidate.source.spec === `github:${candidate.repository}#${candidate.source.commit}`
    : candidate.source?.kind === 'npm'
      && candidate.source.spec === `${candidate.package.name}@${candidate.package.version}`
      && INTEGRITY_PATTERN.test(candidate.source.integrity ?? '')

  return [
    check('manifest-name', typeof candidate.package?.name === 'string' && candidate.package.name.length > 0),
    check('manifest-version', VERSION_PATTERN.test(candidate.package?.version ?? '')),
    check('bundle-entry-declared', safePatch, patch),
    check('license-disclosed', typeof candidate.license === 'string' && candidate.license.trim().length > 0),
    check('lifecycle-scripts-disclosed', scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)
      && Object.values(scripts).every(value => typeof value === 'string')),
    check('source-pinned', sourcePinned, candidate.source?.spec),
  ]
}

