// SERVER ONLY — one audio retention purge run (PRV-02). Uses the service-role client.
//
// Reads storage.audio_retention_days; when it is a valid positive integer, deletes the audio
// of `done` meetings created before the cutoff (oldest first, PURGE_BATCH_LIMIT per run),
// then nulls audio_path + stamps audio_purged_at and writes one audit row per meeting.
// A storage delete failure leaves the row untouched so the next daily run retries it.
// Transcript, notes, todos and chat are never touched.

import { createServerClient } from '@/lib/supabase/server'
import { getAppConfigValue } from '@/lib/config/appConfig'
import { deleteObject } from '@/lib/storage'
import { writeAuditLog } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'
import {
  RETENTION_SETTING_KEY,
  PURGE_BATCH_LIMIT,
  parseRetentionDays,
  retentionCutoff,
  isPurgeEligible,
  isOwnedAudioKey,
} from './policy'

export const RETENTION_ACTOR = 'system:retention'

export interface PurgeSummary {
  retentionDays: number | null
  /** true when the setting is present but not a valid day count (purge stays off). */
  invalidSetting: boolean
  candidates: number
  purged: number
  /** Row changed since selection (requeued, reprocessed, deleted) — left alone. */
  skipped: number
  failed: number
}

const CANDIDATE_COLUMNS = 'id, user_id, status, audio_path, audio_purged_at, storage_provider, created_at'

export async function runRetentionPurge(nowMs: number = Date.now()): Promise<PurgeSummary> {
  const raw = await getAppConfigValue(RETENTION_SETTING_KEY)
  const retentionDays = parseRetentionDays(raw)
  const empty = { candidates: 0, purged: 0, skipped: 0, failed: 0 }
  if (retentionDays === null) {
    return { retentionDays, invalidSetting: raw !== null && raw !== undefined, ...empty }
  }

  const cutoff = retentionCutoff(nowMs, retentionDays)
  const db = createServerClient()
  // Selecting audio_purged_at doubles as a schema preflight: if migration 032 is not applied
  // the query errors here, BEFORE any file is deleted (otherwise the row update would fail
  // after the delete and leave audio_path pointing at a missing file).
  const { data, error } = await db
    .from('meetings')
    .select(CANDIDATE_COLUMNS)
    .eq('status', 'done')
    .not('audio_path', 'is', null)
    .lt('created_at', cutoff.toISOString())
    .order('created_at', { ascending: true })
    .limit(PURGE_BATCH_LIMIT)
  if (error) throw new Error(`retention candidate query failed: ${error.message}`)

  const rows = data ?? []
  let purged = 0
  let skipped = 0
  let failed = 0

  for (const listed of rows) {
    // Re-read right before deleting: the batch can be minutes old, and an admin requeue in
    // between would otherwise lose both the transcript and the audio.
    const { data: m, error: readErr } = await db
      .from('meetings')
      .select(CANDIDATE_COLUMNS)
      .eq('id', listed.id)
      .maybeSingle()
    if (readErr) {
      failed++
      logger.warn('[retention] re-read failed — will retry next run', { meetingId: listed.id, detail: readErr.message })
      continue
    }
    if (!m || !isPurgeEligible(m, cutoff) || m.audio_path !== listed.audio_path) {
      skipped++
      continue
    }
    const audioPath = m.audio_path as string

    // audio_path is user-editable under RLS: only ever delete this meeting's own object.
    if (!isOwnedAudioKey(audioPath, m.user_id, m.id)) {
      failed++
      logger.error('[retention] audio_path does not belong to this meeting — not deleting', { meetingId: m.id })
      continue
    }

    try {
      await deleteObject({ key: audioPath, provider: m.storage_provider })
    } catch (err) {
      failed++
      logger.warn('[retention] storage delete failed — will retry next run', {
        meetingId: m.id,
        detail: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    // Compare-and-set: only clear the row if it is still done and still points at this file.
    const { data: updated, error: updErr } = await db
      .from('meetings')
      .update({ audio_path: null, audio_purged_at: new Date(nowMs).toISOString() })
      .eq('id', m.id)
      .eq('status', 'done')
      .eq('audio_path', audioPath)
      .select('id')
    if (updErr) {
      failed++
      logger.error('[retention] audio deleted but row update failed', { meetingId: m.id, detail: updErr.message })
      continue
    }
    if (!updated || updated.length === 0) {
      skipped++
      logger.warn('[retention] audio deleted but row changed before update', { meetingId: m.id })
      continue
    }

    purged++
    void writeAuditLog({
      actorId: null,
      actorEmail: RETENTION_ACTOR,
      action: 'meeting.audio_purged',
      targetType: 'meeting',
      targetId: m.id,
      metadata: { retention_days: retentionDays, created_at: m.created_at, storage_provider: m.storage_provider },
    })
  }

  return { retentionDays, invalidSetting: false, candidates: rows.length, purged, skipped, failed }
}
