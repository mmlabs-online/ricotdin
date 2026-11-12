// SERVER ONLY — creates a Supabase client authenticated with the user's JWT so
// that Row Level Security policies apply. Use this for any query where RLS must
// scope results to the logged-in user (e.g. transcript chunk retrieval for RAG).
// Never use this for background pipeline writes — use createServerClient() instead.

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export function createUserClient(jwt: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set')
  }
  return createClient<Database>(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
