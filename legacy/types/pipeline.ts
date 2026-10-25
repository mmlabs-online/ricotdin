// TypeScript types and Zod validation schemas for the Gemini pipeline contracts.
// Used to parse and validate Gemini JSON responses before the pipeline stores them.

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Transcript contract (Step A — audio → transcript)
// ---------------------------------------------------------------------------
// Raw Gemini response — timestamps in seconds (float). We convert to ms after
// validation so callers always work in milliseconds.
// Gemini timestamps are approximate; .catch() falls back gracefully on missing
// or invalid values rather than throwing.

const GeminiSegmentRaw = z.object({
  speaker: z.string().catch('Speaker'),
  start_s: z.number().catch(0),
  end_s: z.number().catch(0),
  text: z.string().catch(''),
})

export const GeminiTranscriptSchema = z
  .object({
    language: z.string().catch('unknown'),
    segments: z.array(GeminiSegmentRaw).catch([]),
  })
  .catch({ language: 'unknown', segments: [] })

// TranscriptResult is what the rest of the pipeline consumes (ms, not seconds).
export type TranscriptResult = {
  language: string
  segments: Array<{
    speaker: string
    start_ms: number
    end_ms: number
    text: string
    /** Average word-level confidence for this turn (0–1, 2 d.p.). Null when
     *  Speechmatics does not return confidence scores for a word. */
    confidence?: number | null
  }>
}

// ---------------------------------------------------------------------------
// Analysis contract (Step B — transcript text → notes/todos/calendar)
// ---------------------------------------------------------------------------

const TodoItemSchema = z.object({
  content: z.string().catch(''),
  assignee: z.string().nullable().catch(null),
  due_date: z.string().nullable().catch(null),
  source_segment_index: z.number().int().nullable().catch(null),
})

const CalendarItemSchema = z.object({
  title: z.string().catch(''),
  proposed_at: z.string().nullable().catch(null),
  raw_mention: z.string().catch(''),
  source_segment_index: z.number().int().nullable().catch(null),
})

export const GeminiAnalysisSchema = z
  .object({
    summary: z.string().catch(''),
    notes_markdown: z.string().catch(''),
    todos: z.array(TodoItemSchema).catch([]),
    calendar_suggestions: z.array(CalendarItemSchema).catch([]),
  })
  .catch({ summary: '', notes_markdown: '', todos: [], calendar_suggestions: [] })

export type AnalysisResult = z.infer<typeof GeminiAnalysisSchema>
