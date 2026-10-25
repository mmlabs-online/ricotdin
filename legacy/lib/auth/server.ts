// SERVER ONLY — auth helpers for route handlers.
// Verifies the bearer token and optionally asserts admin role.
// Never import this from client components.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { User } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/** Parse and verify the Bearer token; return the Supabase User or throw a NextResponse. */
export async function requireUser(req: NextRequest): Promise<User> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) {
    throw NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
  }

  const { data: { user }, error } = await createClient<Database>(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.getUser()

  if (error || !user) {
    throw NextResponse.json({ error: 'Invalid or expired session.' }, { status: 401 })
  }
  return user
}

/**
 * Like requireUser but also asserts that user.app_metadata.role === 'admin'.
 * Returns 403 Forbidden for authenticated non-admin callers.
 */
export async function requireAdmin(req: NextRequest): Promise<User> {
  const user = await requireUser(req)
  const role = (user.app_metadata as Record<string, unknown>)?.role as string | undefined
  if (role !== 'admin') {
    throw NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }
  return user
}
