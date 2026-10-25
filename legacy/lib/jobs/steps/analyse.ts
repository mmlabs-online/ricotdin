// SERVER ONLY
//
// Job step: 'analyse'
// Loads the transcript from DB, calls Gemini Flash for summary/notes/todos/
// calendar suggestions, and writes results back.
//
// REL-03: deletes existing todos and calendar_suggestions BEFORE inserting
// new ones so that a retry never produces duplicates.

import { log } from '@/lib/logger'
import { createServerClient } from '@/lib/supabase/server'
import { analyzeTranscript } from '@/lib/gemini/analyze'
import { assertAnalysisHasContent } from '@/lib/pipeline/guards'
import type { TranscriptResult } from '@/types/pipeline'
import type { JobRow } from '../types'

export async function runAnalyse(job: JobRow): Promise<void> {
  const db = createServerClient()
  const meetingId = job.meeting_id
  const userId = job.payload.user_id ?? undefined

  // ── Load transcript from DB ───────────────────────────────────────────────
  const { data: segRows, error: segErr } = await db
    .from('transcript_segments')
    .select('id, segment_index, speaker, start_ms, end_ms, text, confidence')
    .eq('meeting_id', meetingId)
    .order('segment_index', { ascending: true })

  if (segErr) throw new Error(`analyse: failed to load segments: ${segErr.message}`)
  if (!segRows || segRows.length === 0) {
    throw new Error(`analyse: no transcript_segments found for meeting ${meetingId}`)
  }

  // segment_index → DB row id (for FK resolution of todos/calendar citations).
  const segmentIdByIndex = new Map<number, string>(
    segRows.map((r) => [r.segment_index, r.id]),
  )

  // Rebuild the TranscriptResult shape that analyzeTranscript expects.
  const transcript: TranscriptResult = {
    language: 'unknown',  // analyzeTranscript only uses segments; language is cosmetic here
    segments: segRows.map((r) => ({
      speaker: r.speaker ?? '',
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      text: r.text,
      confidence: r.confidence ?? null,
    })),
  }

  // ── Fetch meeting metadata needed for the prompt ──────────────────────────
  const { data: mtg } = await db
    .from('meetings')
    .select('started_at, generation_provider, generation_model')
    .eq('id', meetingId)
    .maybeSingle()

  const modelCtx = mtg?.generation_provider && mtg?.generation_model
    ? { provider: mtg.generation_provider, model: mtg.generation_model }
    : undefined

  // ── Gemini: analyze ───────────────────────────────────────────────────────
  log(`[jobs/analyse] ${meetingId}: calling Gemini with ${segRows.length} segments`)
  const analysis = await analyzeTranscript(
    transcript,
    mtg?.started_at ?? undefined,
    { meetingId, userId, modelCtx },
  )
  log(
    `[jobs/analyse] ${meetingId}: done — ` +
    `${analysis.todos.length} todos, ${analysis.calendar_suggestions.length} suggestions`,
  )
  assertAnalysisHasContent(analysis)

  // ── Write summary + notes ─────────────────────────────────────────────────
  await db.from('meetings')
    .update({ summary: analysis.summary, notes: analysis.notes_markdown })
    .eq('id', meetingId)

  // ── REL-03: delete any prior todos/calendar rows before re-inserting ──────
  await Promise.all([
    db.from('todos').delete().eq('meeting_id', meetingId),
    db.from('calendar_suggestions').delete().eq('meeting_id', meetingId),
  ])

  // ── Insert todos ──────────────────────────────────────────────────────────
  if (analysis.todos.length > 0) {
    const todoRows = analysis.todos.map((t) => ({
      meeting_id: meetingId,
      content: t.content,
      assignee: t.assignee,
      due_date: t.due_date,
      status: 'open' as const,
      source_segment_id:
        t.source_segment_index != null
          ? (segmentIdByIndex.get(t.source_segment_index) ?? null)
          : null,
    }))
    const { error: todoErr } = await db.from('todos').insert(todoRows)
    if (todoErr) throw new Error(`todos insert: ${todoErr.message}`)
  }

  // ── Insert calendar suggestions ───────────────────────────────────────────
  if (analysis.calendar_suggestions.length > 0) {
    const calRows = analysis.calendar_suggestions.map((c) => ({
      meeting_id: meetingId,
      title: c.title,
      proposed_at: c.proposed_at,
      raw_mention: c.raw_mention,
      dismissed: false,
      source_segment_id:
        c.source_segment_index != null
          ? (segmentIdByIndex.get(c.source_segment_index) ?? null)
          : null,
    }))
    const { error: calErr } = await db.from('calendar_suggestions').insert(calRows)
    if (calErr) throw new Error(`calendar_suggestions insert: ${calErr.message}`)
  }

  // ── Advance to 'embed' ────────────────────────────────────────────────────
  await db.from('jobs').update({
    step: 'embed',
    status: 'queued',
    run_after: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
  }).eq('id', job.id)
}
