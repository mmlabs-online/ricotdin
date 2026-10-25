// PATCH  /api/admin/keys/:id  — enable or disable a config entry
// DELETE /api/admin/keys/:id  — permanently remove a config entry
//
// SECURITY:
// - Both endpoints require admin role.
// - Neither endpoint returns value_ciphertext, value_iv, or value_auth_tag.
// - Disabling or deleting the LAST active entry for a config_key is blocked.
// - All mutations are audit-logged with metadata: { configKey, label } only.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { isLastActiveKey } from '@/lib/keys/guards'
import { invalidateKeyCache } from '@/lib/keys/provider'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

const SAFE_SELECT =
  'id, created_at, updated_at, config_key, label, last4, status, disabled_reason, last_used_at'

const CONFIG_KEY_TO_PROVIDER: Record<string, string> = {
  gemini_api_key:       'gemini',
  speechmatics_api_key: 'speechmatics',
  openai_api_key:       'openai',
  grok_api_key:         'grok',
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller: { id: string; email?: string }
  try { caller = await requireAdmin(req) } catch (res) { return res as NextResponse }

  const { id: entryId } = await params

  let body: { status?: unknown; disabled_reason?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

  if (body.status !== 'active' && body.status !== 'disabled') {
    return NextResponse.json(
      { error: 'status must be "active" or "disabled".' },
      { status: 422 },
    )
  }
  const newStatus = body.status as 'active' | 'disabled'
  const disabled_reason =
    typeof body.disabled_reason === 'string' ? body.disabled_reason.trim() || null : null

  const db = createServerClient()

  const { data: entry } = await db
    .from('admin_config')
    .select('id, config_key, label, status')
    .eq('id', entryId)
    .maybeSingle()

  if (!entry) return NextResponse.json({ error: 'Config entry not found.' }, { status: 404 })

  if (newStatus === 'disabled' && entry.status === 'active') {
    const { count } = await db
      .from('admin_config')
      .select('*', { count: 'exact', head: true })
      .eq('config_key', entry.config_key as string)
      .eq('status', 'active')

    if (isLastActiveKey(count ?? 1)) {
      return NextResponse.json(
        {
          error:
            `Cannot disable the last active key for "${entry.config_key}". ` +
            'Add another key first.',
        },
        { status: 422 },
      )
    }
  }

  const { data: updated, error: updateErr } = await db
    .from('admin_config')
    .update({
      status:          newStatus,
      disabled_reason: newStatus === 'active' ? null : disabled_reason,
    })
    .eq('id', entryId)
    .select(SAFE_SELECT)
    .single()

  if (updateErr || !updated) {
    logger.error('[admin/keys] update failed', { detail: updateErr?.message })
    return NextResponse.json({ error: 'Failed to update entry.' }, { status: 500 })
  }

  invalidateKeyCache(CONFIG_KEY_TO_PROVIDER[entry.config_key as string] ?? (entry.config_key as string))

  const action = newStatus === 'active' ? 'admin_config.enable' : 'admin_config.disable'
  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action,
    targetType: 'admin_config',
    targetId:   entryId,
    metadata: {
      configKey: entry.config_key,
      label:     entry.label,
      ...(disabled_reason ? { disabled_reason } : {}),
    },
    ...requestContext(req),
  })

  return NextResponse.json({ key: updated })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller: { id: string; email?: string }
  try { caller = await requireAdmin(req) } catch (res) { return res as NextResponse }

  const { id: entryId } = await params
  const db = createServerClient()

  const { data: entry } = await db
    .from('admin_config')
    .select('id, config_key, label, status')
    .eq('id', entryId)
    .maybeSingle()

  if (!entry) return NextResponse.json({ error: 'Config entry not found.' }, { status: 404 })

  if (entry.status === 'active') {
    const { count } = await db
      .from('admin_config')
      .select('*', { count: 'exact', head: true })
      .eq('config_key', entry.config_key as string)
      .eq('status', 'active')

    if (isLastActiveKey(count ?? 1)) {
      return NextResponse.json(
        {
          error:
            `Cannot delete the last active key for "${entry.config_key}". ` +
            'Disable it or add another key first.',
        },
        { status: 422 },
      )
    }
  }

  const { error: deleteErr } = await db
    .from('admin_config')
    .delete()
    .eq('id', entryId)

  if (deleteErr) {
    logger.error('[admin/keys] delete failed', { detail: deleteErr.message })
    return NextResponse.json({ error: 'Failed to delete entry.' }, { status: 500 })
  }

  invalidateKeyCache(CONFIG_KEY_TO_PROVIDER[entry.config_key as string] ?? (entry.config_key as string))

  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action:     'admin_config.delete',
    targetType: 'admin_config',
    targetId:   entryId,
    metadata:   { configKey: entry.config_key, label: entry.label },
    ...requestContext(req),
  })

  return NextResponse.json({ ok: true })
}
