#!/usr/bin/env node
/**
 * One-off script: promote an existing account to role='admin'.
 *
 * Usage:
 *   npx tsx scripts/seed-admin.ts <email>
 *
 * Requirements:
 *   - .env.local must be present with NEXT_PUBLIC_SUPABASE_URL and
 *     SUPABASE_SERVICE_ROLE_KEY set.
 *   - The account must already exist (register it via the app first).
 *
 * What it does:
 *   1. Looks up the user by email via the admin API.
 *   2. Sets app_metadata.role = 'admin' (source of truth for JWT claims).
 *   3. Updates profiles.role = 'admin' (keeps the display table in sync).
 *
 * SECURITY: This script requires the service role key and must only be run
 * by a trusted operator with access to .env.local. Do NOT allow users to
 * self-promote; call this script manually for the initial admin account.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

async function main() {
  const email = process.argv[2]?.trim()

  if (!email) {
    console.error('Usage: npx tsx scripts/seed-admin.ts <email>')
    process.exit(1)
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      'Missing environment variables. Ensure NEXT_PUBLIC_SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY are set in .env.local',
    )
    process.exit(1)
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ── Find user by email ──────────────────────────────────────────────────────

  const { data: { users }, error: listErr } = await db.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  })

  if (listErr) {
    console.error('Failed to list users:', listErr.message)
    process.exit(1)
  }

  const user = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())

  if (!user) {
    console.error(`No account found for email: ${email}`)
    console.error('Register the account via the app first, then run this script.')
    process.exit(1)
  }

  console.log(`Found user: ${user.id} (${user.email})`)
  const currentRole = (user.app_metadata as Record<string, unknown>)?.role
  if (currentRole === 'admin') {
    console.log('This account is already an admin. Nothing to do.')
    process.exit(0)
  }

  // ── Set app_metadata.role = 'admin' ────────────────────────────────────────

  const { error: metaErr } = await db.auth.admin.updateUserById(user.id, {
    app_metadata: { role: 'admin' },
  })

  if (metaErr) {
    console.error('Failed to update app_metadata:', metaErr.message)
    process.exit(1)
  }

  // ── Sync profiles.role ──────────────────────────────────────────────────────

  const { error: profileErr } = await db
    .from('profiles')
    .update({ role: 'admin' })
    .eq('id', user.id)

  if (profileErr) {
    console.warn('app_metadata updated but profiles.role sync failed:', profileErr.message)
    console.warn(`Run: UPDATE public.profiles SET role='admin' WHERE id='${user.id}';`)
  } else {
    console.log('✓ profiles.role updated.')
  }

  console.log(`\n✓ ${email} is now an admin.`)
  console.log("The new role takes effect on the user's next sign-in (JWT refresh).")
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
