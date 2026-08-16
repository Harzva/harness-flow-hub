export const VERIFICATION_STATES = Object.freeze(['unknown', 'unverified', 'passed', 'failed', 'stale'])

export function resolveVerificationState(result, options) {
  if (result === undefined) return 'unverified'
  if (!VERIFICATION_STATES.includes(result.state)) throw new Error(`invalid verification state: ${result.state}`)
  if (result.state !== 'passed') return result.state

  const verifiedAt = new Date(result.verifiedAt)
  const asOf = new Date(`${options.asOf}T23:59:59.999Z`)
  const maxAgeMs = (options.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000
  if (!Number.isFinite(verifiedAt.valueOf()) || !Number.isFinite(asOf.valueOf())) return 'stale'
  if (verifiedAt > asOf || asOf.valueOf() - verifiedAt.valueOf() > maxAgeMs) return 'stale'
  return 'passed'
}

