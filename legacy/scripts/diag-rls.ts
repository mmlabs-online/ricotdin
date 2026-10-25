/**
 * Definitive RLS test — run with:
 *   npx tsx scripts/diag-rls.ts <meetingId>
 *
 * Mints a REAL access token for the meeting's owner (service-role generateLink →
 * verify), then calls match_transcript_chunks exactly as retrieve.ts does, under
 * that user JWT. Compares against service-role and pure-anon. This tells us
 * whether RLS (or role fallback) is what zeroes out the real chat path.
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') })

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

async function j(res: Response) { return res.json().catch(() => null) }

async function getOwnerEmail(userId: string): Promise<string | null> {
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })
  const body = await j(res)
  return body?.email ?? null
}

async function mintOwnerToken(email: string): Promise<string | null> {
  // 1. Generate a magiclink (service role) → returns hashed_token
  const genRes = await fetch(`${URL_BASE}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  })
  const gen = await j(genRes)
  const tokenHash = gen?.hashed_token ?? gen?.properties?.hashed_token
  if (!tokenHash) { console.log('  generate_link failed:', JSON.stringify(gen).slice(0, 200)); return null }

  // 2. Verify the token_hash → returns a session with access_token
  const verRes = await fetch(`${URL_BASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  })
  const ver = await j(verRes)
  if (!ver?.access_token) { console.log('  verify failed:', JSON.stringify(ver).slice(0, 200)); return null }
  return ver.access_token
}

async function callRpc(label: string, apikey: string, bearer: string, meetingId: string, emb: unknown) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/match_transcript_chunks`, {
    method: 'POST',
    headers: { apikey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: emb, match_count: 8, filter_meeting_ids: [meetingId] }),
  })
  const body = await j(res)
  const n = Array.isArray(body) ? body.length : `ERR ${res.status}`
  console.log(`   ${label}: rows=${n}`, !Array.isArray(body) ? JSON.stringify(body).slice(0, 200) : '')
}

async function plainSelect(label: string, apikey: string, bearer: string, meetingId: string) {
  const res = await fetch(`${URL_BASE}/rest/v1/transcript_chunks?meeting_id=eq.${meetingId}&select=id`, {
    headers: { apikey, Authorization: `Bearer ${bearer}`, Prefer: 'count=exact' },
  })
  const range = res.headers.get('content-range')
  console.log(`   ${label}: HTTP ${res.status}, count=${range?.split('/')[1] ?? '?'}`)
}

async function whoami(token: string) {
  const res = await fetch(`${URL_BASE}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } })
  const b = await j(res)
  console.log('   token user id:', b?.id, 'role:', b?.role, 'aud:', b?.aud)
}

async function main() {
  const meetingId = process.argv[2]
  if (!meetingId) { console.error('Usage: npx tsx scripts/diag-rls.ts <meetingId>'); process.exit(1) }

  // Owner + a sample embedding
  const m = await (await fetch(`${URL_BASE}/rest/v1/meetings?id=eq.${meetingId}&select=user_id`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json()
  const ownerId = m?.[0]?.user_id
  const c = await (await fetch(`${URL_BASE}/rest/v1/transcript_chunks?meeting_id=eq.${meetingId}&select=embedding&limit=1`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json()
  const emb = c?.[0]?.embedding // pgvector string

  console.log('\n=== RLS test for meeting', meetingId, '===')
  console.log('owner:', ownerId)

  console.log('\n[1] service role (no RLS):')
  await callRpc('rpc', SERVICE, SERVICE, meetingId, emb)
  await plainSelect('select', SERVICE, SERVICE, meetingId)

  console.log('\n[2] pure anon (no user JWT):')
  await callRpc('rpc', ANON, ANON, meetingId, emb)
  await plainSelect('select', ANON, ANON, meetingId)

  console.log('\n[3] owner JWT (real chat path):')
  const email = await getOwnerEmail(ownerId)
  console.log('   owner email:', email)
  const token = email ? await mintOwnerToken(email) : null
  if (token) {
    await whoami(token)
    await callRpc('rpc', ANON, token, meetingId, emb)
    await plainSelect('select', ANON, token, meetingId)
  } else {
    console.log('   could not mint owner token — skipping')
  }

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
