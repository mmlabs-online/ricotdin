// GET  /api/admin/features — list features (filterable)
// POST /api/admin/features — create a new feature row
//
// SECURITY: admin-only, server-enforced via requireAdmin().

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/server'
import { listFeatures, createFeature } from '@/lib/features'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'

const VALID_STATUSES = ['done', 'partial', 'not_started'] as const
const VALID_PRIORITIES = ['high', 'medium', 'low'] as const

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const { searchParams } = new URL(req.url)
  const module_prefix = searchParams.get('module_prefix') ?? undefined
  const status = searchParams.get('status') as 'done' | 'partial' | 'not_started' | undefined
  const search = searchParams.get('search') ?? undefined
  const page = Number(searchParams.get('page') ?? 1)
  const perPage = Number(searchParams.get('perPage') ?? 200)

  try {
    const features = await listFeatures({ module_prefix, status, search, page, perPage })
    return NextResponse.json({ features })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let admin
  try {
    admin = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const key = typeof body.key === 'string' ? body.key.trim().toUpperCase() : ''
  const module_prefix = typeof body.module_prefix === 'string' ? body.module_prefix.trim().toUpperCase() : ''
  const module_name = typeof body.module_name === 'string' ? body.module_name.trim() : ''
  const title = typeof body.title === 'string' ? body.title.trim() : ''

  if (!key) return NextResponse.json({ error: 'key is required.' }, { status: 422 })
  if (!module_prefix) return NextResponse.json({ error: 'module_prefix is required.' }, { status: 422 })
  if (!module_name) return NextResponse.json({ error: 'module_name is required.' }, { status: 422 })
  if (!title) return NextResponse.json({ error: 'title is required.' }, { status: 422 })

  const status = typeof body.status === 'string' ? body.status : 'not_started'
  if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return NextResponse.json({ error: 'status must be done, partial, or not_started.' }, { status: 422 })
  }

  const priority = body.priority ?? null
  if (priority !== null && !VALID_PRIORITIES.includes(priority as typeof VALID_PRIORITIES[number])) {
    return NextResponse.json({ error: 'priority must be high, medium, low, or null.' }, { status: 422 })
  }

  const toArray = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === 'string') as string[] : []

  try {
    const feature = await createFeature(
      {
        key,
        module_prefix,
        module_name,
        title,
        description: typeof body.description === 'string' ? body.description.trim() || undefined : undefined,
        user_story: typeof body.user_story === 'string' ? body.user_story.trim() || undefined : undefined,
        content: typeof body.content === 'string' ? body.content || undefined : undefined,
        status: status as typeof VALID_STATUSES[number],
        priority: priority as 'high' | 'medium' | 'low' | null,
        note_tags: toArray(body.note_tags),
        depends_on: toArray(body.depends_on),
        blocks: toArray(body.blocks),
        key_files: toArray(body.key_files),
      },
      admin.email ?? 'unknown',
    )

    const ctx = requestContext(req)
    void writeAuditLog({
      actorId: admin.id,
      actorEmail: admin.email ?? 'unknown',
      action: 'feature.create',
      targetType: 'feature',
      targetId: feature.id,
      metadata: { key: feature.key, module_prefix, title },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })

    return NextResponse.json({ feature }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    // Key uniqueness violation from Postgres
    if (msg.includes('duplicate') || msg.includes('unique')) {
      return NextResponse.json({ error: `Feature key "${key}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
