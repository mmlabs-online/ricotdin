// SERVER ONLY — this module reads SUPABASE_SERVICE_ROLE_KEY which must never
// reach the browser. Import it only from /app/api route handlers or other
// server-only /lib modules.

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Server/service-role client — bypasses RLS. Use this in the processing
// pipeline and other background writes where there is no user session.
//
// Env vars are read inside the function (not at module level) so that the
// check script's dotenv.config() call has time to run before the values are
// captured. In Next.js, env vars are loaded before any module code runs so
// this is a non-issue in production, but reading lazily is safer in both.
export function createServerClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local',
    )
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
