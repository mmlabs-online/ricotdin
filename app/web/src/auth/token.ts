// Access-token timing (ARC-11, CLAUDE.md §0.3). The token itself lives only in memory.

/** Refresh this long before the token expires (clock skew + request time). */
export const REFRESH_SKEW_MS = 60_000
const MAX_TTL_MS = 24 * 3600 * 1000

export function isExpiringSoon(expiresAt: number | null, now: number, skewMs = REFRESH_SKEW_MS): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return true
  return expiresAt - now <= skewMs
}

/** `expires_in` (seconds, from the API) → absolute ms. Nonsense counts as already expired. */
export function expiresAtFrom(expiresInSeconds: number, now: number): number {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return now
  return now + Math.min(expiresInSeconds * 1000, MAX_TTL_MS)
}
