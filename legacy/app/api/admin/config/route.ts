// GET /api/admin/config
//
// Returns all rows from app_config (key, value, description, updated_at, updated_by).
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { logger } from '@/lib/logger'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('app_config')
    .select('key, value, description, updated_at, updated_by')
    .order('key')

  if (error) {
    logger.error('[admin/config] fetch failed', { detail: error.message })
    return NextResponse.json({ error: 'Failed to fetch config.' }, { status: 500 })
  }

  return NextResponse.json({ config: data ?? [] })
}
