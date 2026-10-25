// SERVER ONLY — fire-and-forget usage logging for every AI provider call.
//
// Call logUsage() immediately after any AI API request (success OR failure).
// A logging failure MUST NEVER propagate to the caller — the real work always wins.
//
// Unit contract:
//   unit='tokens'        → quantity = total_tokens  (Gemini text / embedding)
//   unit='audio_seconds' → quantity = audio_seconds (Speechmatics STT)
//
// Never aggregate quantity across different units — the values are incommensurable.

import { createServerClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import type { UsageUnit, UsageStatus } from '@/types/database'

export type { UsageUnit, UsageStatus }

export interface UsageEntry {
  provider: string       // 'gemini' | 'gemini-embedding' | 'speechmatics' | ...
  model: string          // specific model id, e.g. 'gemini-2.5-flash'
  operation: string      // 'analyze' | 'chat' | 'embed' | 'transcribe'
  unit: UsageUnit
  quantity: number       // total_tokens OR audio_seconds — must match unit
  // Token fields (only for token-metered calls)
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  // STT field (only for audio-duration-metered calls)
  audio_seconds?: number
  // Outcome
  status?: UsageStatus   // defaults to 'ok'
  http_code?: number
  // Attribution (metadata only — no content)
  meeting_id?: string | null
  user_id?: string | null
  key_id?: string | null
}

/**
 * Write one usage_log row. Fire-and-forget: never throws, never awaited by caller.
 * Call this after every AI provider request, whether it succeeded or failed.
 */
export function logUsage(entry: UsageEntry): void {
  // Intentionally not awaited. Errors are only logged, never rethrown.
  void _write(entry)
}

async function _write(entry: UsageEntry): Promise<void> {
  try {
    const db = createServerClient()
    const { error } = await db.from('usage_log').insert({
      provider:      entry.provider,
      model:         entry.model,
      operation:     entry.operation,
      unit:          entry.unit,
      quantity:      entry.quantity,
      input_tokens:  entry.input_tokens  ?? null,
      output_tokens: entry.output_tokens ?? null,
      total_tokens:  entry.total_tokens  ?? null,
      audio_seconds: entry.audio_seconds ?? null,
      status:        entry.status        ?? 'ok',
      http_code:     entry.http_code     ?? null,
      meeting_id:    entry.meeting_id    ?? null,
      user_id:       entry.user_id       ?? null,
      key_id:        entry.key_id        ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    if (error) {
      logger.warn('[usage] log insert failed', { detail: error.message })
    }
  } catch (e) {
    logger.warn('[usage] log write exception', { detail: String(e) })
  }
}
