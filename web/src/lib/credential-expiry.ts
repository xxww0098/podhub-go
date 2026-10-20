/**
 * Ozon Seller keys are time-limited: `/v1/roles` answers their `expires_at`,
 * and Cloud projects it as `key_expires_at_ms` / `credentialKeyExpiresAtMs`
 * (millisecond epoch). `null` (or absent) is the legacy key that never lapses,
 * so only a real timestamp already passed counts as expired — the same
 * predicate Cloud uses to refuse the Store's Ozon exits with
 * `CREDENTIAL_EXPIRED` (HTTP 409).
 */
export function isCredentialExpiredAt(
  expiresAtMs: number | null | undefined,
  now = Date.now(),
): boolean {
  return expiresAtMs != null && expiresAtMs <= now
}
