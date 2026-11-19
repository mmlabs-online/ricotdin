// The running release, from the API's public GET /version.json ({"version": "v2.2.3"}; a build
// commit when no release tag is set, "unknown" otherwise). Pure: what the sidebar shows.

const RELEASE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/
const COMMIT = /^[0-9a-f]{7,40}$/i

/** "v2.2.3", a 7-char commit, or null (unknown / unexpected answer: show nothing). */
export function versionLabel(body: unknown): string | null {
  const raw = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  const release = RELEASE.exec(value)
  if (release) return `v${release[1]}`
  if (COMMIT.test(value)) return value.slice(0, 7).toLowerCase()
  return null
}
