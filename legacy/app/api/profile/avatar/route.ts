// POST /api/profile/avatar
//
// Step 1 of avatar upload: validates contentType + size, generates an R2 key,
// returns a presigned PUT URL.  The client does the PUT to R2 directly, then
// calls PATCH /api/profile { avatar_key } to confirm and update the DB.
//
// No file bytes are sent to this server — only metadata.

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/server'
import { createSignedUploadUrl } from '@/lib/storage'
import { logger } from '@/lib/logger'

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const MAX_AVATAR_BYTES = 2 * 1024 * 1024 // 2 MB

const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { contentType, size } = body

  // Validate content type
  if (typeof contentType !== 'string' || !(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return NextResponse.json(
      { error: `contentType must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}.` },
      { status: 422 },
    )
  }

  // Validate size
  if (typeof size !== 'number' || size <= 0) {
    return NextResponse.json({ error: 'size must be a positive number.' }, { status: 422 })
  }
  if (size > MAX_AVATAR_BYTES) {
    return NextResponse.json(
      { error: `Avatar must be smaller than ${MAX_AVATAR_BYTES / 1024 / 1024} MB.` },
      { status: 422 },
    )
  }

  const ext = EXT_MAP[contentType]
  const avatarKey = `avatars/${user.id}/${randomUUID()}${ext}`

  let uploadUrl: string
  try {
    uploadUrl = await createSignedUploadUrl({ key: avatarKey, contentType })
  } catch (e) {
    logger.error('[POST /api/profile/avatar] presigned URL failed', { detail: String(e) })
    return NextResponse.json({ error: 'Failed to generate upload URL.' }, { status: 500 })
  }

  return NextResponse.json({ uploadUrl, avatarKey })
}
