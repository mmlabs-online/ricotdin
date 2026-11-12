// PATCH  /api/admin/storage/:id — enable or disable a storage config
// DELETE /api/admin/storage/:id — permanently remove a storage config
//
// SECURITY: requireAdmin; never returns ciphertext; mutations audit-logged.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import {
  STORAGE_SAFE_SELECT,
  maskStorageRow,
  invalidateStorageConfigCache,
} from '@/lib/storage/config'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let caller: { id: string; email?: string }
  try {
    caller = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id } = await params

  let body: { status?: unknown; disabled_reason?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  if (body.status !== 'active' && body.status !== 'disabled') {
    return NextResponse.json({ error: "status must be 'active' or 'disabled'." }, { status: 422 })
  }
  const disabledReason =
    body.status === 'disabled' && typeof body.disabled_reason === 'string'
      ? body.disabled_reason.slice(0, 200)
      : null

  const db = createServerClient()
  const { data: row, error } = await db
    .from('storage_config')
    .update({ status: body.status, disabled_reason: disabledReason })
    .eq('id', id)
    .select(STORAGE_SAFE_SELECT)
    .single()

  if (error || !row) {
    logger.error('[admin/storage] update failed', { detail: error?.message })
    return NextResponse.json({ error: 'Storage config not found.' }, { status: 404 })
  }

  invalidateStorageConfigCache()
  void writeAuditLog({
    actorId: caller.id,
    actorEmail: caller.email ?? '',
    action: 'storage_config.update',
    targetType: 'storage_config',
    targetId: id,
    metadata: { status: body.status, label: (row as { label: string }).label },
    ...requestContext(req),
  })

  return NextResponse.json({ config: maskStorageRow(row as never) })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let caller: { id: string; email?: string }
  try {
    caller = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id } = await params
  const db = createServerClient()

  const { data: existing } = await db
    .from('storage_config')
    .select('id, label')
    .eq('id', id)
    .maybeSingle()

  const { error } = await db.from('storage_config').delete().eq('id', id)
  if (error) {
    logger.error('[admin/storage] delete failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to delete storage config.' }, { status: 500 })
  }

  invalidateStorageConfigCache()
  void writeAuditLog({
    actorId: caller.id,
    actorEmail: caller.email ?? '',
    action: 'storage_config.delete',
    targetType: 'storage_config',
    targetId: id,
    metadata: { label: (existing as { label?: string } | null)?.label ?? null },
    ...requestContext(req),
  })

  return NextResponse.json({ ok: true })
}
