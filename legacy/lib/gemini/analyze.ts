// SERVER ONLY — reads Gemini API keys. Import only from /app/api or server /lib.
//
// Step B of the pipeline: pass the transcript text to Gemini Flash (text-only,
// cheap) and extract summary, meeting notes, todos, and calendar suggestions.
// Segments are referenced by their 0-based array index so citations map back
// to the transcript_segments rows inserted in Step A.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Schema } from '@google/genai'
import { log } from '@/lib/logger'
import { PipelineError } from './errors'
import { resolveModel, getDefaultGenerationModel } from '@/lib/ai/registry'
import type { ModelCtx } from '@/lib/ai/types'
import {
  GeminiAnalysisSchema,
  type AnalysisResult,
  type TranscriptResult,
} from '@/types/pipeline'

// ---------------------------------------------------------------------------
// Gemini response schema
// ---------------------------------------------------------------------------

const ANALYSIS_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description:
        'A few factual sentences covering the meeting purpose, participants, and ' +
        'topics discussed — based only on the transcript, no fabrication',
    },
    notes_markdown: {
      type: Type.STRING,
      description:
        'Structured meeting notes in Markdown with section headings (Key points, ' +
        'Feedback, Notes/Remarks) and bullets — sections present only if the ' +
        'transcript had content for them; no fabrication',
    },
    todos: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: 'Action item description' },
          assignee: { type: Type.STRING, nullable: true },
          due_date: {
            type: Type.STRING,
            nullable: true,
            description: 'YYYY-MM-DD or null',
          },
          source_segment_index: {
            type: Type.INTEGER,
            nullable: true,
            description: '0-based index into the segments array',
          },
        },
        required: ['content', 'assignee', 'due_date', 'source_segment_index'],
      },
    },
    calendar_suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          proposed_at: {
            type: Type.STRING,
            nullable: true,
            description: 'ISO 8601 datetime or null if vague',
          },
          raw_mention: {
            type: Type.STRING,
            description: 'Exact phrase from the transcript',
          },
          source_segment_index: {
            type: Type.INTEGER,
            nullable: true,
            description: '0-based index into the segments array',
          },
        },
        required: ['title', 'proposed_at', 'raw_mention', 'source_segment_index'],
      },
    },
  },
  required: ['summary', 'notes_markdown', 'todos', 'calendar_suggestions'],
}

// ---------------------------------------------------------------------------
// System prompt — loaded from ai-instruction/ai-gen/generate-meeting.md
// ---------------------------------------------------------------------------
//
// The system prompt is authored as markdown OUTSIDE the codebase so it can be
// iterated on without code changes. It is read from disk (this app runs as a
// long-lived `next start` server with the repo present, not serverless) and
// cached for the process lifetime after first successful load.

const SYSTEM_PROMPT_PATH = join(process.cwd(), 'ai-instruction', 'ai-gen', 'generate-meeting.md')

let cachedSystemPrompt: string | null = null

async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt
  let raw: string
  try {
    raw = await readFile(SYSTEM_PROMPT_PATH, 'utf8')
  } catch (err) {
    throw new PipelineError(
      `Failed to read analyze system prompt at ${SYSTEM_PROMPT_PATH}: ` +
        (err instanceof Error ? err.message : String(err)),
    )
  }
  const trimmed = raw.replace(/\r\n/g, '\n').trim()
  if (!trimmed) {
    throw new PipelineError(`Analyze system prompt at ${SYSTEM_PROMPT_PATH} is empty`)
  }
  cachedSystemPrompt = trimmed
  return trimmed
}

// ---------------------------------------------------------------------------
// User content builder — the dynamic MEETING_DATE + TRANSCRIPT for one call
// ---------------------------------------------------------------------------

function buildUserContent(
  segments: TranscriptResult['segments'],
  strict = false,
  meetingDate?: string,
): string {
  // Format the transcript with segment indices so Gemini can cite them back.
  const transcriptText = segments
    .map(
      (s, i) =>
        `[${i}] ${s.speaker} (${(s.start_ms / 1000).toFixed(1)}s): ${s.text}`,
    )
    .join('\n')

  const dateLine = meetingDate
    ? `MEETING_DATE: ${meetingDate}`
    : 'MEETING_DATE: (unknown — do not guess or fabricate any dates)'

  const base = `${dateLine}

TRANSCRIPT (each line prefixed with its 0-based segment index [N]):
${transcriptText}`

  return strict
    ? base + '\n\nReturn ONLY valid JSON matching the required schema. No markdown fences, no explanation.'
    : base
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

function parseResult(raw: string): AnalysisResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    throw new PipelineError(
      `Gemini analysis: JSON.parse failed. First 300 chars: ${raw.slice(0, 300)}`,
    )
  }

  const result = GeminiAnalysisSchema.safeParse(parsed)
  if (!result.success) {
    throw new PipelineError(
      `Gemini analysis: schema validation failed: ${result.error.message}`,
    )
  }

  // Gemini structured-JSON output sometimes encodes newlines as the two-character
  // sequence \n (backslash + n) rather than the proper JSON \n escape, so they
  // survive JSON.parse as literal text. Unescape them before storing.
  return {
    ...result.data,
    notes_markdown: result.data.notes_markdown.replace(/\\n/g, '\n'),
    summary: result.data.summary.replace(/\\n/g, '\n'),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AnalyzeContext {
  meetingId?: string | null
  userId?: string | null
  /** AIP-03: reuse the per-meeting locked model instead of the system default. */
  modelCtx?: ModelCtx
}

/**
 * Analyse the transcript text with Gemini Flash (text-only, no audio upload).
 * Returns summary, markdown notes, todos, and calendar suggestions.
 * Segment indices in the result map directly to the array passed in.
 *
 * @param transcript   Parsed transcript from Step A.
 * @param meetingDate  ISO 8601 timestamp of when the meeting took place.
 * @param ctx          Optional attribution context for usage logging.
 */
export async function analyzeTranscript(
  transcript: TranscriptResult,
  meetingDate?: string,
  ctx?: AnalyzeContext,
): Promise<AnalysisResult> {
  if (transcript.segments.length === 0) {
    return { summary: '', notes_markdown: '', todos: [], calendar_suggestions: [] }
  }

  log(`[analyze] analysing transcript with ${transcript.segments.length} segments` +
    (meetingDate ? ` (meeting date: ${meetingDate})` : ''))

  const systemPrompt = await loadSystemPrompt()
  const { adapter, model } = ctx?.modelCtx
    ? resolveModel(ctx.modelCtx.provider, ctx.modelCtx.model)
    : getDefaultGenerationModel()

  const result = await adapter.generateStructured({
    messages:      buildUserContent(transcript.segments, false, meetingDate),
    retryMessages: buildUserContent(transcript.segments, true,  meetingDate),
    schema: ANALYSIS_RESPONSE_SCHEMA,
    model,
    systemInstruction: systemPrompt,
    parse: parseResult,
    operation: 'analyze',
    ctx,
  })

  return result.data
}
