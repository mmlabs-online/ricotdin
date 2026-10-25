// POST /api/meetings/:id/regenerate
//
// Re-runs Step B of the pipeline (Gemini analysis) in isolation: reads the
// existing transcript_segments from DB, calls analyzeTranscript(), and
// overwrites meetings.summary + meetings.notes. Does NOT re-transcribe.
//
// Returns { ok: true, summary, notes } on success.
// Returns 422 if no transcript segments exist for this meeting.
//
// Ownership enforced server-side; Gemini key never leaves the server.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/server'
import { analyzeTranscript } from '@/lib/gemini/analyze'
import { logger } from '@/lib/logger'
import type { TranscriptResult } from '@/types/pipeline'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let caller
  try {
    caller = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const { id: meetingId } = await params
  const db = createServerClient()

  const { data: meeting } = await db
    .from('meetings')
    .select('id, user_id, language, started_at, generation_provider, generation_model')
    .eq('id', meetingId)
    .maybeSingle()

  if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })
  if (meeting.user_id !== caller.id) return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })

  const { data: segRows, error: segErr } = await db
    .from('transcript_segments')
    .select('*')
    .eq('meeting_id', meetingId)
    .order('segment_index')

  if (segErr) {
    logger.error('[regenerate] segments fetch failed', { detail: segErr.message })
    return NextResponse.json({ error: 'Failed to load transcript.' }, { status: 500 })
  }

  const segments = segRows ?? []
  if (segments.length === 0) {
    return NextResponse.json({ error: 'No transcript available to analyze.' }, { status: 422 })
  }

  const transcript: TranscriptResult = {
    language: meeting.language ?? 'unknown',
    segments: segments.map((s) => ({
      speaker: s.speaker ?? 'Speaker',
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.text,
    })),
  }

  const modelCtx = meeting.generation_provider && meeting.generation_model
    ? { provider: meeting.generation_provider, model: meeting.generation_model }
    : undefined

  try {
    const analysis = await analyzeTranscript(
      transcript,
      meeting.started_at ?? undefined,
      { meetingId, userId: meeting.user_id ?? undefined, modelCtx },
    )

    const { error: updateErr } = await db
      .from('meetings')
      .update({
        summary: analysis.summary,
        notes: analysis.notes_markdown,
        status: 'done',
        error_message: null,
      })
      .eq('id', meetingId)

    if (updateErr) {
      logger.error('[regenerate] meetings update failed', { detail: updateErr.message })
      return NextResponse.json({ error: 'Failed to save results.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, summary: analysis.summary, notes: analysis.notes_markdown })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed.'
    logger.error('[regenerate] analyzeTranscript failed', { detail: message })
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 })
  }
}
