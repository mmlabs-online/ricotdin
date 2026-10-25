// Regression tests for BUG-002 — avatar_key ownership. Pure, no I/O.
// Run with: npm test
//
// avatar_key is user-writable (PATCH /api/profile, and directly under the profiles
// column-level UPDATE grant). The server signs a download URL for it (GET /api/profile)
// and deletes the old one on replace with R2 credentials, so it must only ever name the
// caller's own avatar object: `avatars/<user_id>/<uuid>.(jpg|png|webp)`
// (app/api/profile/avatar/route.ts).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOwnedAvatarKey } from '../lib/profile/avatarKey.js'

const me = '11111111-1111-1111-1111-111111111111'
const other = '99999999-9999-9999-9999-999999999999'
const uuid = 'a0b1c2d3-e4f5-4678-9abc-def012345678'

describe('isOwnedAvatarKey', () => {
  it('accepts the caller\'s own avatar keys as issued by /api/profile/avatar', () => {
    for (const ext of ['.jpg', '.png', '.webp']) {
      assert.equal(isOwnedAvatarKey(`avatars/${me}/${uuid}${ext}`, me), true, ext)
    }
  })

  it('BUG-002: rejects another user\'s meeting audio key (read via signed URL / delete via R2)', () => {
    assert.equal(isOwnedAvatarKey(`${other}/22222222-2222-2222-2222-222222222222.webm`, me), false)
  })

  it('BUG-002: rejects another user\'s avatar', () => {
    assert.equal(isOwnedAvatarKey(`avatars/${other}/${uuid}.png`, me), false)
  })

  it('BUG-002: rejects the caller\'s own meeting audio (not an avatar)', () => {
    assert.equal(isOwnedAvatarKey(`${me}/22222222-2222-2222-2222-222222222222.webm`, me), false)
  })

  it('rejects traversal, nesting, odd extensions and malformed ids', () => {
    for (const key of [
      `avatars/${me}/../${other}/${uuid}.png`,
      `avatars/${me}/${uuid}.png/../../x`,
      `avatars/${me}/sub/${uuid}.png`,
      `avatars/${me}/${uuid}.gif`,
      `avatars/${me}/${uuid}`,
      `avatars/${me}/${uuid}.PNG.webm`,
      `avatars/${me}/not-a-uuid.png`,
      `/avatars/${me}/${uuid}.png`,
      `avatars//${me}/${uuid}.png`,
    ]) {
      assert.equal(isOwnedAvatarKey(key, me), false, key)
    }
  })

  it('rejects an uppercase UUID (randomUUID() is always lowercase)', () => {
    assert.equal(isOwnedAvatarKey(`avatars/${me}/${uuid.toUpperCase()}.png`, me), false)
  })

  it('rejects a userId containing a slash', () => {
    assert.equal(isOwnedAvatarKey(`avatars/a/b/${uuid}.png`, 'a/b'), false)
  })

  it('rejects empty values', () => {
    assert.equal(isOwnedAvatarKey('', me), false)
    assert.equal(isOwnedAvatarKey(`avatars/${me}/${uuid}.png`, ''), false)
  })
})
