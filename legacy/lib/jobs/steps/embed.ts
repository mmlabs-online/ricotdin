// SERVER ONLY
//
// Job step: 'embed'
// Loads segments from DB, chunks them, embeds via Gemini, writes
// transcript_chunks, marks the meeting done, and closes the job.
//
// REL-03: deletes existing transcript_chunks BEFORE inserting new ones
// so that a retry never produces duplicates.

import { log } from '@/lib/logger'
import { logActivity } from '@/lib/activity/logActivity'
import { createServerClient } from '@/lib/supabase/server'
import { embedChunks } from '@/lib/gemini/embed'
import { chunkSegments } from '@/lib/pipeline/chunk'
import type { JobRow } from '../types'

export async function runEmbed(job: JobRow): Promise<void> {
  const db = createServerClient()
  const meetingId = job.meeting_id
  const userId = job.payload.user_id ?? undefined

  // ── Load segments ─────────────────────────────────────────────────────────
  const { data: segRows, error: segErr } = await db
    .from('transcript_segments')
    .select('speaker, start_ms, end_ms, text, confidence')
    .eq('meeting_id', meetingId)
    .order('segment_index', { ascending: true })

  if (segErr) throw new Error(`embed: failed to load segments: ${segErr.message}`)
  if (!segRows || segRows.length === 0) {
    throw new Error(`embed: no transcript_segments found for meeting ${meetingId}`)
  }

  const segments = segRows.map((r) => ({
    speaker: r.speaker ?? '',
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    text: r.text,
    confidence: r.confidence ?? null,
  }))

  // ── Chunk + embed ─────────────────────────────────────────────────────────
  const chunks = chunkSegments(segments)
  log(`[jobs/embed] ${meetingId}: ${chunks.length} RAG chunks, embedding…`)

  const usageCtx = { meetingId, userId }

  if (chunks.length > 0) {
    const vectors = await embedChunks(chunks.map((c) => c.content), usageCtx)

    // ── REL-03: delete prior chunks before inserting ──────────────────────
    await db.from('transcript_chunks').delete().eq('meeting_id', meetingId)

    const chunkRows = chunks.map((c, idx) => ({
      meeting_id: meetingId,
      chunk_index: c.chunk_index,
      content: c.content,
      embedding: vectors[idx],
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      token_count: c.token_count,
    }))
    const { error: chunkErr } = await db.from('transcript_chunks').insert(chunkRows)
    if (chunkErr) throw new Error(`transcript_chunks insert: ${chunkErr.message}`)
  }

  // ── Mark meeting done ─────────────────────────────────────────────────────
  await db.from('meetings').update({ status: 'done' }).eq('id', meetingId)
  log(`[jobs/embed] ${meetingId}: done ✓`)

  if (userId) {
    logActivity({ userId, eventType: 'processing_done', meetingId })
  }

  // ── Close the job ─────────────────────────────────────────────────────────
  await db.from('jobs').update({
    status: 'done',
    locked_at: null,
    locked_by: null,
  }).eq('id', job.id)
}
