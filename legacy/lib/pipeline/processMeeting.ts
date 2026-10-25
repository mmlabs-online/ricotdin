// SERVER ONLY — uses service role key and Gemini API key. Never import from
// client components or expose to the browser.
//
// Pipeline orchestrator: takes a meetingId, runs the two Gemini steps, writes
// all results to Postgres, and sets status='done'. Any error sets
// status='failed' and writes meetings.error_message.
//
// NOTE: a non-awaited call to processMeeting() is safe on a long-lived Next.js
// server (npm start). If the server restarts mid-job, the meeting is left in
// status='processing'; trigger a re-run manually via POST /api/meetings/:id/process.

import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { log, logger } from '@/lib/logger'
import { logActivity } from '@/lib/activity/logActivity'
import { createServerClient } from '@/lib/supabase/server'
import { getObjectBytes } from '@/lib/storage'
import { ownedAudioPath } from '@/lib/retention/policy'
import { resolveGenerationModel } from '@/lib/ai/resolve'
import { analyzeTranscript } from '@/lib/gemini/analyze'
import { embedChunks } from '@/lib/gemini/embed'
import { chunkSegments } from './chunk'
import { transcribeWithSpeechmatics } from '@/lib/speechmatics/transcribe'
import { assertAnalysisHasContent } from './guards'
import { applyQuotaMovement } from '@/lib/quota/applyQuotaMovement'
import { getAudioDurationSeconds } from '@/lib/audio/ffprobe'

/**
 * Process a meeting end-to-end:
 *   pending/failed → processing → (transcription + analysis + embeddings) → done
 *
 * Atomic guard: uses a conditional UPDATE to claim the job. If the meeting is
 * already processing or done, this function returns without doing anything —
 * safe to call multiple times or from concurrent requests.
 */
export async function processMeeting(meetingId: string, speakerCount?: number, pick?: { provider: string; model: string }): Promise<void> {
  const db = createServerClient()

  // ── Atomic claim ─────────────────────────────────────────────────────────
  // Only run if the meeting is in a processable state. Using .in() so that
  // manual re-runs can restart failed meetings.
  const { data: claimed } = await db
    .from('meetings')
    .update({ status: 'processing', error_message: null })
    .in('status', ['pending', 'failed'])
    .eq('id', meetingId)
    .select('id, audio_path, storage_provider, duration_seconds, started_at, user_id, generation_provider, generation_model')
    .maybeSingle()

  if (!claimed) {
    log(`[pipeline] ${meetingId}: not claimable (already processing/done or missing)`)
    return
  }

  log(`[pipeline] ${meetingId}: starting processing`)
  let tmpAudioPath: string | null = null
  let estimateSeconds = 0
  let transcriptionSettled = false

  try {
    // ── Download audio from Supabase Storage ──────────────────────────────
    if (!claimed.audio_path) {
      throw new Error('Meeting has no audio_path — cannot process')
    }
    // BUG-003: never download a forged audio_path (another user's recording).
    const audioPath = ownedAudioPath(claimed)
    if (!audioPath) {
      throw new Error('Meeting audio_path does not belong to this meeting — refusing to process')
    }

    log(`[pipeline] ${meetingId}: downloading audio from storage`)
    const audioBuffer = await getObjectBytes({
      key: audioPath,
      provider: claimed.storage_provider,
    })

    // Write to a temp file so the ffmpeg transcode can read it from disk.
    // The extension is preserved so ffmpeg can auto-detect the input format.
    const ext = extname(audioPath) || '.webm'
    tmpAudioPath = join(tmpdir(), `meeting-${randomUUID()}${ext}`)
    await writeFile(tmpAudioPath, audioBuffer)
    log(`[pipeline] ${meetingId}: audio written to ${tmpAudioPath} (${audioBuffer.length} bytes)`)

    // ── QUO-02: Pre-flight quota gate ─────────────────────────────────────
    // Estimate audio duration via ffprobe; fall back to meetings.duration_seconds.
    // Reserve that many seconds from the user's quota wallet. On 'insufficient',
    // mark failed and return immediately (bypass the catch refund path).
    if (claimed.user_id) {
      const probed = await getAudioDurationSeconds(tmpAudioPath).catch(() => 0)
      estimateSeconds = Math.ceil(probed > 0 ? probed : (claimed.duration_seconds ?? 0))
      if (estimateSeconds > 0) {
        const reserve = await applyQuotaMovement({
          userId: claimed.user_id,
          deltaAudioSeconds: -estimateSeconds,
          deltaAgentQueries: 0,
          reason: 'generate',
          dedupKey: `gen:${meetingId}:reserve`,
          allowOverdraw: false,
          meetingId,
          metadata: { estimate_seconds: estimateSeconds },
        })
        if (reserve.status === 'insufficient') {
          const msg = `QUOTA_BLOCKED: Insufficient audio balance. Required: ${estimateSeconds}s, remaining: ${reserve.audioRemaining}s.`
          await db.from('meetings').update({ status: 'failed', error_message: msg }).eq('id', meetingId)
          log(`[pipeline] ${meetingId}: ${msg}`)
          logActivity({
            userId: claimed.user_id,
            eventType: 'processing_failed',
            meetingId,
            metadata: { reason: 'quota_blocked', required_seconds: estimateSeconds, remaining_seconds: reserve.audioRemaining },
          })
          return
        }
      }
    }

    // ── AIP-03: Per-meeting model lock ────────────────────────────────────
    // Resolve (and write, if new) the generation provider+model pair.
    // On re-queue the lock is already set — reuse it without re-resolving.
    // AIP-06 will replace getDefaultGenerationModel() with resolveGenerationModel(userId)
    // (PRF-08 → ADM-10 fallback chain).
    const modelCtx =
      claimed.generation_provider && claimed.generation_model
        ? { provider: claimed.generation_provider, model: claimed.generation_model }
        : await resolveGenerationModel(claimed.user_id, pick)
    if (!claimed.generation_provider) {
      await db
        .from('meetings')
        .update({ generation_provider: modelCtx.provider, generation_model: modelCtx.model })
        .eq('id', meetingId)
    }

    // ── Step A: Transcription ─────────────────────────────────────────────
    // Speechmatics Batch API handles audio of any length natively — no ffmpeg
    // splitting required. The audio file is uploaded directly from disk.
    const usageCtx = { meetingId: meetingId, userId: claimed.user_id ?? undefined, speakerCount }
    const { transcript, audioSeconds: realSeconds } = await transcribeWithSpeechmatics(tmpAudioPath, usageCtx)
    log(
      `[pipeline] ${meetingId}: transcript done — ` +
        `${transcript.segments.length} segments, language=${transcript.language}`,
    )

    // ── QUO-02: Settle quota reservation ─────────────────────────────────
    // Transcription succeeded — reconcile the estimate vs real duration.
    // If realSeconds < estimateSeconds: delta is positive → refund the diff.
    // If realSeconds > estimateSeconds: delta is negative → deduct the overage
    //   (allowOverdraw=true: accept even if balance briefly goes negative here).
    // Done BEFORE the empty-segment check so silent audio gets a full refund.
    if (claimed.user_id && estimateSeconds > 0) {
      await applyQuotaMovement({
        userId: claimed.user_id,
        deltaAudioSeconds: estimateSeconds - realSeconds,
        deltaAgentQueries: 0,
        reason: 'generate',
        dedupKey: `gen:${meetingId}:settle`,
        allowOverdraw: true,
        meetingId,
        metadata: { estimate_seconds: estimateSeconds, real_seconds: realSeconds },
      })
    }
    transcriptionSettled = true

    // Empty transcript: audio was silent, too short, or the codec was
    // unrecognised. Mark the meeting done with a clear note so the user sees
    // a readable state instead of a failure. No segments/todos/embeddings to insert.
    if (transcript.segments.length === 0) {
      await db
        .from('meetings')
        .update({
          status: 'done',
          summary: 'No speech detected in this recording.',
          notes: '',
          language: transcript.language,
        })
        .eq('id', meetingId)
      log(`[pipeline] ${meetingId}: done (empty transcript — no speech detected)`)
      if (claimed.user_id) {
        logActivity({ userId: claimed.user_id, eventType: 'processing_done', meetingId, metadata: { empty_transcript: true } })
      }
      return
    }

    // Insert transcript_segments and build segment-index → row-id map
    const segmentRows = transcript.segments.map((s, idx) => ({
      meeting_id: meetingId,
      segment_index: idx,
      speaker: s.speaker,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.text,
      confidence: s.confidence ?? null,
    }))

    const { data: insertedSegments, error: segErr } = await db
      .from('transcript_segments')
      .insert(segmentRows)
      .select('id, segment_index')

    if (segErr) throw new Error(`transcript_segments insert: ${segErr.message}`)

    // Map segment index → DB id for citation FK resolution
    const segmentIdByIndex = new Map<number, string>(
      (insertedSegments ?? []).map((r) => [r.segment_index, r.id]),
    )

    // Update language from transcript
    await db
      .from('meetings')
      .update({ language: transcript.language })
      .eq('id', meetingId)

    // ── Step B: Analysis ──────────────────────────────────────────────────
    // Pass started_at so the prompt can anchor relative date phrases
    // ("next Tuesday") to when the meeting actually happened.
    const analysis = await analyzeTranscript(
      transcript,
      claimed.started_at ?? undefined,
      { meetingId, userId: claimed.user_id ?? undefined, modelCtx },
    )
    log(
      `[pipeline] ${meetingId}: analysis done — ` +
        `${analysis.todos.length} todos, ${analysis.calendar_suggestions.length} calendar suggestions`,
    )

    // Guard: reject if Gemini returned neither summary nor notes. This catches
    // API failures that produce a structurally valid but semantically empty result.
    assertAnalysisHasContent(analysis)

    // Update summary + notes on the meetings row
    await db
      .from('meetings')
      .update({ summary: analysis.summary, notes: analysis.notes_markdown })
      .eq('id', meetingId)

    // Insert todos (resolve source_segment_index → source_segment_id)
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

    // Insert calendar_suggestions
    if (analysis.calendar_suggestions.length > 0) {
      const calRows = analysis.calendar_suggestions.map((c) => ({
        meeting_id: meetingId,
        title: c.title,
        proposed_at: c.proposed_at,
        raw_mention: c.raw_mention,
        source_segment_id:
          c.source_segment_index != null
            ? (segmentIdByIndex.get(c.source_segment_index) ?? null)
            : null,
        dismissed: false,
      }))
      const { error: calErr } = await db.from('calendar_suggestions').insert(calRows)
      if (calErr) throw new Error(`calendar_suggestions insert: ${calErr.message}`)
    }

    // ── RAG: chunk + embed + insert transcript_chunks ─────────────────────
    const chunks = chunkSegments(transcript.segments)
    log(`[pipeline] ${meetingId}: ${chunks.length} RAG chunks, embedding…`)

    if (chunks.length > 0) {
      const vectors = await embedChunks(chunks.map((c) => c.content), usageCtx)

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

    // ── Mark done ─────────────────────────────────────────────────────────
    await db.from('meetings').update({ status: 'done' }).eq('id', meetingId)
    log(`[pipeline] ${meetingId}: done ✓`)
    if (claimed.user_id) {
      logActivity({ userId: claimed.user_id, eventType: 'processing_done', meetingId })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // ── QUO-02: Refund reserved quota on terminal failure ─────────────────
    // Only runs when the reserve was issued but settle was never reached,
    // meaning transcription (or a step before it) threw before we could settle.
    if (!transcriptionSettled && estimateSeconds > 0 && claimed.user_id) {
      await applyQuotaMovement({
        userId: claimed.user_id,
        deltaAudioSeconds: estimateSeconds,
        deltaAgentQueries: 0,
        reason: 'refund',
        dedupKey: `gen:${meetingId}:refund`,
        allowOverdraw: false,
        meetingId,
        metadata: { reason: 'pipeline_failure', error: message.slice(0, 200) },
      }).catch((refundErr: unknown) => {
        logger.error('[pipeline] quota refund failed (non-fatal)', { detail: String(refundErr) })
      })
    }

    logger.error(`[pipeline] FAILED`, { meetingId, detail: message })
    await db
      .from('meetings')
      .update({ status: 'failed', error_message: message.slice(0, 500) })
      .eq('id', meetingId)
    if (claimed.user_id) {
      logActivity({ userId: claimed.user_id, eventType: 'processing_failed', meetingId, metadata: { error: message.slice(0, 200) } })
    }
    throw err
  } finally {
    // Clean up the downloaded source file regardless of success/failure.
    if (tmpAudioPath) {
      unlink(tmpAudioPath).catch((e: unknown) => {
        logger.warn('[pipeline] failed to delete temp audio file', { detail: String(e) })
      })
    }
  }
}
