// Own data export and account deletion (PRF-13). Pure.

/** The delete dialog's "type your username" check (the API compares the same way). */
export function deleteConfirmed(typed: string, username: string | null): boolean {
  return username !== null && username !== '' && typed.trim() === username
}

/** The download name from `Content-Disposition`, never a path; the fallback otherwise. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  const m = header?.match(/filename="([^"]+)"/)
  const name = m?.[1]?.split(/[\\/]/).pop()?.trim()
  return name || fallback
}
