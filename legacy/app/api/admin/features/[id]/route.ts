// GET  /api/admin/features/:id — full feature detail (id = row UUID or key)
// PATCH /api/admin/features/:id — edit fields; writes audit log entry
//
// SECURITY: admin-only, server-enforced via requireAdmin().

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/server'
import { getFeature, updateFeature } from '@/lib/features'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { createServerClient } from '@/lib/supabase/server'
import type { UpdateFeatureFields } from '@/lib/features'

// ── Allowed editable fields ───────────────────────────────────────────────────

const EDITABLE: Array<keyof UpdateFeatureFields> = [
  'title',
  'description',
  'content',
  'status',
  'priority',
  'note_tags',
  'depends_on',
  'blocks',
  'key_files',
  'change_note',
]

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id } = await params

  // Support both UUID and key (e.g. "REC-01")
  const feature = await getFeature(id)
  if (!feature) {
    // If not found by key, try by UUID via service-role query
    const db = createServerClient()
    const { data } = await db.from('features').select('*').eq('id', id).maybeSingle()
    if (!data) return NextResponse.json({ error: 'Feature not found.' }, { status: 404 })
    return NextResponse.json({ feature: data })
  }

  return NextResponse.json({ feature })
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin
  try {
    admin = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id } = await params

  // Resolve to a UUID if caller passed the key
  let featureId = id
  let featureKey = id
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    const feature = await getFeature(id)
    if (!feature) return NextResponse.json({ error: 'Feature not found.' }, { status: 404 })
    featureId = feature.id
    featureKey = feature.key
  } else {
    const db = createServerClient()
    const { data } = await db.from('features').select('key').eq('id', id).maybeSingle()
    featureKey = (data as { key: string } | null)?.key ?? id
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Strip any fields that are not editable
  const fields: UpdateFeatureFields = {}
  const changedFields: string[] = []
  for (const field of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(fields as any)[field] = body[field]
      changedFields.push(field)
    }
  }

  if (changedFields.length === 0) {
    return NextResponse.json({ error: 'No editable fields provided.' }, { status: 400 })
  }

  // Validate status if provided
  if (
    fields.status !== undefined &&
    !['done', 'partial', 'not_started'].includes(fields.status)
  ) {
    return NextResponse.json(
      { error: 'status must be done, partial, or not_started.' },
      { status: 422 },
    )
  }

  // Validate priority if provided
  if (
    fields.priority !== undefined &&
    fields.priority !== null &&
    !['high', 'medium', 'low'].includes(fields.priority)
  ) {
    return NextResponse.json(
      { error: 'priority must be high, medium, low, or null.' },
      { status: 422 },
    )
  }

  const actorEmail = admin.email ?? 'unknown'

  try {
    const updated = await updateFeature(featureId, fields, actorEmail)

    // Audit log — fire-and-forget
    const ctx = requestContext(req)
    void writeAuditLog({
      actorId: admin.id,
      actorEmail,
      action: 'feature.update',
      targetType: 'feature',
      targetId: featureId,
      metadata: { key: featureKey, changed_fields: changedFields },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return NextResponse.json({ feature: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
