// Avatar storage-key ownership (BUG-002). Pure; tested in tests/avatar-key.test.ts.
//
// Keys are issued by POST /api/profile/avatar as `avatars/<user_id>/<uuid><ext>`.
// `profiles.avatar_key` is user-writable, and the server both signs a download URL for it and
// deletes the previous one with R2 credentials — so it must only ever name the caller's own
// avatar, never another object in the bucket (e.g. someone's meeting audio).

// Extensions must match EXT_MAP in app/api/profile/avatar/route.ts.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const KEY_RE = new RegExp(`^avatars/([^/]+)/${UUID}\\.(jpg|png|webp)$`)

export function isOwnedAvatarKey(key: string, userId: string): boolean {
  if (!key || !userId) return false
  const m = KEY_RE.exec(key)
  return m !== null && m[1] === userId
}
