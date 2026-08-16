const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/

/** Credential declarations are identifiers only; secret values never belong in plans or persisted metadata. */
export function credentialNames(values: string[]): string[] {
  const names = [...new Set(values)]
  if (names.some(value => !CREDENTIAL_NAME.test(value))) throw new Error('credential-name-required')
  return names.sort()
}

export const telemetryPolicy = {
  enabled: false,
  persistedCredentialFields: [] as string[],
} as const
