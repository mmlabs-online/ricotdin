/**
 * One-off RAG diagnostic — run with:
 *   npx tsx scripts/diag-chunks.ts <meetingId>
 *
 * Uses the SERVICE-ROLE key over PostgREST (bypasses RLS, no realtime/ws) to
 * answer: does this meeting actually have transcript_chunks stored, and do
 * their embeddings have the right dimension? Compares against segments.
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') })

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

async function rest(table: string, query: string, head = false): Promise<{ count: number | null; body: unknown }> {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?${query}`, {
    method: head ? 'HEAD' : 'GET',
    headers: {
      apikey: SERVICE!,
      Authorization: `Bearer ${SERVICE}`,
      Prefer: 'count=exact',
    },
  })
  const range = res.headers.get('content-range') // e.g. "0-4/5" or "*/5"
  const count = range ? Number(range.split('/')[1]) : null
  const body = head ? null : await res.json().catch(() => null)
  if (!res.ok) console.error(`  [${table}] HTTP ${res.status}`, body)
  return { count: Number.isNaN(count as number) ? null : count, body }
}

async function main() {
  const meetingId = process.argv[2]
  if (!meetingId) { console.error('Usage: npx tsx scripts/diag-chunks.ts <meetingId>'); process.exit(1) }
  if (!URL_BASE || !SERVICE) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

  console.log('\n=== RAG diagnostic for meeting', meetingId, '===')

  // Ownership / scope — the RLS decider after migration 025 (admin bypass removed)
  const mtg = await rest('meetings', `id=eq.${meetingId}&select=user_id,folder_id,title,status`)
  const mrow = Array.isArray(mtg.body) ? mtg.body[0] : null
  if (mrow) {
    console.log('meeting.user_id (owner):', mrow.user_id)
    console.log('meeting.folder_id:      ', mrow.folder_id ?? '(none)')
    console.log('meeting.status:         ', mrow.status)
    // Resolve owner + all admins so we can see who can access via RLS
    const prof = await rest('profiles', `select=id,username,role&or=(id.eq.${mrow.user_id},role.eq.admin)`)
    if (Array.isArray(prof.body)) {
      console.log('relevant profiles (owner + admins):')
      for (const p of prof.body as Array<Record<string, unknown>>) {
        const isOwner = p.id === mrow.user_id ? ' ← OWNER' : ''
        console.log(`   ${p.id}  role=${p.role}  username=${p.username}${isOwner}`)
      }
    }
  }

  const seg = await rest('transcript_segments', `meeting_id=eq.${meetingId}&select=id`, true)
  const chunk = await rest('transcript_chunks', `meeting_id=eq.${meetingId}&select=id`, true)
  console.log('transcript_segments:', seg.count)
  console.log('transcript_chunks:  ', chunk.count)

  const sample = await rest('transcript_chunks', `meeting_id=eq.${meetingId}&select=id,chunk_index,content,embedding&order=chunk_index&limit=1`)
  const row = Array.isArray(sample.body) ? sample.body[0] : null

  if (!row) {
    console.log('\n⚠ No chunk rows exist → RAG will ALWAYS return NO_CONTEXT for this meeting.')
    console.log('  Likely cause: embeddings were never stored. Fix: re-run processing.')
  } else {
    const emb = row.embedding as unknown
    let parsed: number[] | null = null
    if (Array.isArray(emb)) parsed = emb as number[]
    else if (typeof emb === 'string') { try { parsed = JSON.parse(emb) as number[] } catch { /* */ } }
    console.log('\nsample chunk id:', row.id, 'index:', row.chunk_index)
    console.log('embedding type:', typeof emb, Array.isArray(emb) ? '(array)' : '')
    console.log('embedding dimension:', parsed ? parsed.length : 'UNPARSEABLE', '(expected 768)')
    console.log('content preview:', String(row.content).slice(0, 80))
    console.log('\n✓ Chunks exist. Now testing the RPC directly (service role, no RLS)…')

    // Reuse chunk 0's own embedding as the query — it must match itself ~1.0.
    // Test BOTH shapes: as a JSON array (what retrieve.ts sends) and as a
    // pgvector string. If array→0 but string→N, the bug is the array cast.
    const embArray = parsed // number[]
    const embString = typeof emb === 'string' ? emb : JSON.stringify(parsed)

    async function callRpc(shape: string, value: unknown) {
      const res = await fetch(`${URL_BASE}/rest/v1/rpc/match_transcript_chunks`, {
        method: 'POST',
        headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query_embedding: value, match_count: 8, filter_meeting_ids: [meetingId] }),
      })
      const body = await res.json().catch(() => null)
      const n = Array.isArray(body) ? body.length : `ERR ${res.status}`
      const top = Array.isArray(body) && body[0] ? Number(body[0].similarity).toFixed(3) : '-'
      console.log(`   query_embedding as ${shape}: rows=${n}, topSimilarity=${top}`,
        !Array.isArray(body) ? JSON.stringify(body).slice(0, 200) : '')
    }

    await callRpc('ARRAY (as retrieve.ts sends)', embArray)
    await callRpc('STRING (pgvector text)', embString)

    // Also test with NO filter (global) to rule out the filter_meeting_ids arg.
    async function callRpcNoFilter(shape: string, value: unknown) {
      const res = await fetch(`${URL_BASE}/rest/v1/rpc/match_transcript_chunks`, {
        method: 'POST',
        headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query_embedding: value, match_count: 8 }),
      })
      const body = await res.json().catch(() => null)
      const n = Array.isArray(body) ? body.length : `ERR ${res.status}`
      console.log(`   [no filter] query_embedding as ${shape}: rows=${n}`)
    }
    await callRpcNoFilter('ARRAY', embArray)
    await callRpcNoFilter('STRING', embString)
  }

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
