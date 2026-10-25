/**
 * Connectivity check — run with: npm run check
 *
 * Verifies that both GEMINI_API_KEY and Supabase credentials work end-to-end
 * before starting real development. Reads credentials from .env.local.
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// Load .env.local from the project root before importing any service modules.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') })

import { generateText } from '../lib/gemini/client.js'
import { createServerClient } from '../lib/supabase/server.js'

function checkRequiredEnv(): boolean {
  const required = [
    'GEMINI_API_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    console.error('\n✗ Missing env vars:', missing.join(', '))
    console.error('  → Fill them in .env.local (use .env.example as the template)')
    return false
  }
  return true
}

async function checkGemini(): Promise<void> {
  console.log('\n--- Gemini ---')
  try {
    const reply = await generateText('Reply with exactly: "Gemini connectivity OK"')
    console.log('✓ Reply:', reply.trim())
  } catch (err) {
    console.error('✗ Gemini error:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

async function checkSupabase(): Promise<void> {
  console.log('\n--- Supabase ---')
  try {
    const supabase = createServerClient()
    const { count, error } = await supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })

    if (error) {
      if (error.message.includes('relation') && error.message.includes('does not exist')) {
        console.error(
          '✗ Table "meetings" not found.\n  → Apply schema.sql in the Supabase SQL editor first, then re-run npm run check.',
        )
      } else {
        console.error('✗ Supabase error:', error.message)
      }
      process.exitCode = 1
      return
    }

    console.log(`✓ meetings table reachable. Row count: ${count ?? 0}`)
  } catch (err) {
    console.error('✗ Supabase error:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

void (async () => {
  console.log('Running connectivity checks…')
  if (!checkRequiredEnv()) {
    process.exitCode = 1
    return
  }
  await checkGemini()
  await checkSupabase()
  console.log('\nDone.')
})()
