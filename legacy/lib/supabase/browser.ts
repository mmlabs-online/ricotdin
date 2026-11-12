import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Browser client — uses the anon key, scoped by RLS to the logged-in user.
// Safe to import from client components and pages.
export const browserClient = createClient<Database>(supabaseUrl, supabaseAnonKey)
