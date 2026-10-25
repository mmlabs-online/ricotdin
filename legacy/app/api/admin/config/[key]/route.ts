// PATCH /api/admin/config/:key
// Body: { value: boolean | number | string | null }
//
// Updates a single config key. Value must be a JSON primitive (not object/array).
// Unknown keys are rejected (must seed via migration first).
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { isValidConfigValue } from '@/lib/admin/config'
import { invalidateAppConfigCache } from '@/lib/config/appConfig'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  let caller
  try {
    caller = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { key } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const b = body as Record<string, unknown>
  if (!('value' in b)) {
    return NextResponse.json({ error: 'Request body must include a "value" field.' }, { status: 422 })
  }
  if (!isValidConfigValue(b.value)) {
    return NextResponse.json({ error: 'value must be a JSON primitive (boolean, number, string, or null).' }, { status: 422 })
  }

  const db = createServerClient()

  // Verify key exists before updating
  const { data: existing, error: selectErr } = await db
    .from('app_config')
    .select('key')
    .eq('key', key)
    .maybeSingle()

  if (selectErr) {
    logger.error('[admin/config/:key] select failed', { detail: selectErr.message })
    return NextResponse.json({ error: 'Failed to look up config key.' }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: `Unknown config key: "${key}".` }, { status: 404 })
  }

  const { data, error: updateErr } = await db
    .from('app_config')
    .update({ value: b.value, updated_by: caller.id })
    .eq('key', key)
    .select('key, value, description, updated_at, updated_by')
    .single()

  if (updateErr) {
    logger.error('[admin/config/:key] update failed', { detail: updateErr.message })
    return NextResponse.json({ error: 'Failed to update config.' }, { status: 500 })
  }

  // Drop the cached value so the new setting applies on the next read, not in 30s.
  invalidateAppConfigCache(key)

  const { ipAddress, userAgent } = requestContext(req)
  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action:     'config.update',
    targetType: 'config',
    targetId:   key,
    metadata:   { value: b.value },
    ipAddress,
    userAgent,
  })

  return NextResponse.json({ config: data })
}
