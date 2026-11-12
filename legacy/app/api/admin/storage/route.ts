// GET  /api/admin/storage        — list storage configs (masked; never ciphertext)
// POST /api/admin/storage        — create a new R2 config (optionally test-first)
// POST /api/admin/storage?test=1 — test connection only, without saving
//
// SECURITY:
// - requireAdmin on every method.
// - secret_ciphertext / iv / auth_tag are NEVER returned.
// - the secret access key is AES-256-GCM encrypted before insert.
// - every mutation is audit-logged with { provider, label } only (no secrets).

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { encryptSecret } from '@/lib/crypto'
import { testR2Connection } from '@/lib/storage'
import {
  STORAGE_SAFE_SELECT,
  maskStorageRow,
  invalidateStorageConfigCache,
} from '@/lib/storage/config'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('storage_config')
    .select(STORAGE_SAFE_SELECT)
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('[admin/storage] list failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to load storage configs.' }, { status: 500 })
  }

  return NextResponse.json({
    configs: (data ?? []).map((r) => maskStorageRow(r as never)),
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let caller: { id: string; email?: string }
  try {
    caller = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: {
    label?: unknown
    account_id?: unknown
    access_key_id?: unknown
    secret_access_key?: unknown
    bucket?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
  const accessKeyId = typeof body.access_key_id === 'string' ? body.access_key_id.trim() : ''
  const secretAccessKey = typeof body.secret_access_key === 'string' ? body.secret_access_key.trim() : ''
  const bucket = typeof body.bucket === 'string' ? body.bucket.trim() : ''

  if (!label || label.length > 80) {
    return NextResponse.json({ error: 'label is required (1–80 chars).' }, { status: 422 })
  }
  for (const [name, val] of [
    ['account_id', accountId],
    ['access_key_id', accessKeyId],
    ['secret_access_key', secretAccessKey],
    ['bucket', bucket],
  ] as const) {
    if (!val) return NextResponse.json({ error: `${name} is required.` }, { status: 422 })
  }
  if (secretAccessKey.length < 8) {
    return NextResponse.json({ error: 'secret_access_key looks too short.' }, { status: 422 })
  }

  const creds = { accountId, accessKeyId, secretAccessKey, bucket }

  // Test-only mode: verify credentials without saving.
  const testOnly = req.nextUrl.searchParams.get('test') === '1'
  if (testOnly) {
    const result = await testR2Connection(creds)
    return NextResponse.json(result, { status: result.ok ? 200 : 422 })
  }

  // Always verify before persisting — a bad config would break all uploads.
  const test = await testR2Connection(creds)
  if (!test.ok) {
    return NextResponse.json(
      { error: `Connection test failed: ${test.error ?? 'unknown error'}` },
      { status: 422 },
    )
  }

  let encrypted: { ciphertext: string; iv: string; authTag: string }
  try {
    encrypted = encryptSecret(secretAccessKey)
  } catch (err) {
    logger.error('[admin/storage] encryption failed', {
      detail: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json(
      { error: 'Failed to encrypt secret. Verify KEY_ENCRYPTION_SECRET is configured.' },
      { status: 500 },
    )
  }

  const db = createServerClient()
  const { data: row, error: insertErr } = await db
    .from('storage_config')
    .insert({
      provider: 'r2',
      label,
      account_id: accountId,
      access_key_id: accessKeyId,
      bucket,
      secret_ciphertext: encrypted.ciphertext,
      secret_iv: encrypted.iv,
      secret_auth_tag: encrypted.authTag,
      secret_last4: secretAccessKey.slice(-4),
      status: 'active',
      created_by: caller.id,
    })
    .select(STORAGE_SAFE_SELECT)
    .single()

  if (insertErr || !row) {
    logger.error('[admin/storage] insert failed', { detail: insertErr?.message })
    return NextResponse.json({ error: 'Failed to save storage config.' }, { status: 500 })
  }

  invalidateStorageConfigCache()
  void writeAuditLog({
    actorId: caller.id,
    actorEmail: caller.email ?? '',
    action: 'storage_config.create',
    targetType: 'storage_config',
    targetId: (row as { id: string }).id,
    metadata: { provider: 'r2', label },
    ...requestContext(req),
  })

  return NextResponse.json({ config: maskStorageRow(row as never) }, { status: 201 })
}
