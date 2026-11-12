/** Two letters for the avatar: from the username, else the email's local part. */
export function initials(user: { username: string | null; email: string } | null): string {
  if (!user) return ''
  const source = (user.username || user.email.split('@')[0] || '').trim()
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2)
  return letters.toUpperCase()
}
