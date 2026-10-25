// Pure function — no I/O, no imports from Gemini or Supabase.
// Tested in tests/chunk.test.ts.

import type { TranscriptResult } from '../../types/pipeline.js'

export type Chunk = {
  chunk_index: number
  content: string
  start_ms: number
  end_ms: number
  token_count: number
}

// ~300 tokens per chunk, 1 segment of overlap between consecutive chunks.
// Character count used as a fast token approximation (1 token ≈ 4 chars).
const CHUNK_TARGET_CHARS = 1_200 // ≈ 300 tokens
const OVERLAP_SEGMENTS = 1

/**
 * Group transcript segments into retrieval-sized passages for RAG embedding.
 * Each chunk carries the combined text, time range, and approximate token count.
 * Deterministic — same input always produces the same output.
 *
 * @param segments  The TranscriptResult.segments array (sorted by start_ms).
 */
export function chunkSegments(
  segments: TranscriptResult['segments'],
): Chunk[] {
  if (segments.length === 0) return []

  const chunks: Chunk[] = []
  let i = 0

  while (i < segments.length) {
    const slice: typeof segments = []
    let chars = 0
    let j = i

    // Accumulate segments until we hit the character target
    while (j < segments.length) {
      slice.push(segments[j])
      chars += segments[j].text.length
      j++
      if (chars >= CHUNK_TARGET_CHARS) break
    }

    const content = slice
      .map((s) => `[${s.speaker}] ${s.text}`)
      .join('\n')

    chunks.push({
      chunk_index: chunks.length,
      content,
      start_ms: slice[0].start_ms,
      end_ms: slice[slice.length - 1].end_ms,
      token_count: Math.ceil(content.length / 4),
    })

    // Advance: apply overlap only when we filled a full chunk (j < segments.length).
    // On the last partial chunk (j === segments.length) there's nothing left to
    // overlap into, so advance straight to j to exit the loop.
    // Always advance by at least i+1 to guard against infinite loops on
    // single segments that exceed the target length.
    i = j >= segments.length
      ? j
      : Math.max(i + 1, j - OVERLAP_SEGMENTS)
  }

  return chunks
}
