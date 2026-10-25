// Pure validation helpers for auth inputs.
// No I/O — import from anywhere (client or server).

/** Return the username normalized to lowercase + trimmed. */
export function normalizeUsername(raw: string): string {
  return raw.toLowerCase().trim()
}

/**
 * Validate a username.
 * Returns null on success, or a human-readable error string on failure.
 * Expects the normalized (lowercase) form.
 */
export function validateUsername(username: string): string | null {
  if (username.length < 3) return 'Username must be at least 3 characters.'
  if (username.length > 30) return 'Username must be at most 30 characters.'
  if (!/^[a-z0-9_-]+$/.test(username))
    return 'Username may only contain lowercase letters, digits, hyphens, and underscores.'
  return null
}

/**
 * Validate an email address (basic format only — real validation happens on
 * the Supabase side).
 */
export function validateEmail(email: string): string | null {
  if (!email.includes('@') || email.length < 3) return 'Enter a valid email address.'
  return null
}

/** Validate a password (minimum length only for now). */
export function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  return null
}

/**
 * Returns true if the identifier looks like an email address (contains '@').
 * Used to decide whether to look up by email or by username.
 */
export function looksLikeEmail(identifier: string): boolean {
  return identifier.includes('@')
}
