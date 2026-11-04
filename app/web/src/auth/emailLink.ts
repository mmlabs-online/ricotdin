// Email links (§0.3) carry their single-use token in the fragment: `/verify-email#token=…`,
// `/reset-password#token=…` — never sent to a server or logged.
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/

export function readHashToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token')
  return token && TOKEN.test(token) ? token : null
}

/** Remove the token from the address bar and history once it has been read. */
export function forgetHashToken(): void {
  try {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  } catch {
    // not fatal: the token is single use
  }
}
