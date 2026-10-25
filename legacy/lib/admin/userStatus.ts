// Pure helper: derive a 3-way account status from the underlying signals.
// No I/O — fully unit-testable.
//
// Two separate concepts are combined here:
//   * banned_until      (auth.users) — admin disabled the account.
//   * email_confirmed_at (auth.users) — whether the user verified their email.
//
// Mapping (banned takes precedence — a disabled account can't sign in regardless):
//   banned                              → 'disabled'   (admin disabled the account)
//   not banned + email not confirmed    → 'unverified' (signed up, awaiting email verification)
//   not banned + email confirmed        → 'active'

export type UserAccountStatus = 'unverified' | 'active' | 'disabled'

export function deriveUserStatus(args: {
  bannedUntil: string | null | undefined
  emailConfirmedAt: string | null | undefined
  now?: Date
}): UserAccountStatus {
  const { bannedUntil, emailConfirmedAt, now = new Date() } = args
  const banned = !!bannedUntil && new Date(bannedUntil) > now
  if (banned) return 'disabled'
  return emailConfirmedAt ? 'active' : 'unverified'
}
