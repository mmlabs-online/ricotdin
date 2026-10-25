// SERVER ONLY — reads Gemini API keys. Import only from /app/api or server /lib.
//
// Generates a grounded answer from retrieved transcript chunks.
// Answers must be based ONLY on the provided context; invented citations are
// filtered out before returning so the caller can trust chunk_id references.

import { Type, type Schema } from '@google/genai'
import { z } from 'zod'
import { resolveModel, getDefaultGenerationModel } from '@/lib/ai/registry'
import type { ModelCtx } from '@/lib/ai/types'
import type { RetrievedChunk } from '@/lib/rag/retrieve'
import type { ChatRole, Citation } from '@/types/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  role: ChatRole
  content: string
}

export interface AnswerResult {
  answer: string
  citations: Citation[]
}

// ---------------------------------------------------------------------------
// Zod schema — validates and narrows the model's JSON output
// ---------------------------------------------------------------------------

const CitationSchema = z.object({
  chunk_id: z.string(),
  meeting_id: z.string(),
  start_ms: z.number(),
  end_ms: z.number(),
})

const AnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(CitationSchema),
})

// ---------------------------------------------------------------------------
// Gemini JSON response schema
// ---------------------------------------------------------------------------

const ANSWER_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description: 'Answer grounded only in the provided transcript excerpts',
    },
    citations: {
      type: Type.ARRAY,
      description: 'Transcript chunks cited in the answer (use exact ids from the excerpts)',
      items: {
        type: Type.OBJECT,
        properties: {
          chunk_id: { type: Type.STRING },
          meeting_id: { type: Type.STRING },
          start_ms: { type: Type.INTEGER },
          end_ms: { type: Type.INTEGER },
        },
        required: ['chunk_id', 'meeting_id', 'start_ms', 'end_ms'],
      },
    },
  },
  required: ['answer', 'citations'],
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

function buildPrompt(
  question: string,
  chunks: RetrievedChunk[],
  history: HistoryMessage[],
): string {
  const excerpts = chunks
    .map(
      (c) =>
        `chunk_id=${c.id} meeting_id=${c.meeting_id} start_ms=${c.start_ms} end_ms=${c.end_ms}\n${c.content}`,
    )
    .join('\n\n---\n\n')

  const historyText =
    history.length > 0
      ? '\n\nPrior conversation:\n' +
        history
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n')
      : ''

  return `You are a meeting assistant. Answer the user's question using ONLY the transcript excerpts below.
If the answer is not in the excerpts, say clearly "I don't see that discussed in this meeting."
Do not invent or infer information beyond what is explicitly stated in the excerpts.
When citing, copy the chunk_id, meeting_id, start_ms, and end_ms values exactly from the excerpts — do not make up IDs.${historyText}

Transcript excerpts:
${excerpts}

User question: ${question}`
}

// ---------------------------------------------------------------------------
// Exported pure helper — used by tests and internally
// ---------------------------------------------------------------------------

/**
 * Filters citations to only those whose chunk_id was in the provided input set.
 * Prevents the model from inventing IDs that don't correspond to real chunks.
 */
export function filterValidCitations(
  citations: Citation[],
  validChunkIds: Set<string>,
): Citation[] {
  return citations.filter((c) => validChunkIds.has(c.chunk_id))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AnswerContext {
  meetingId?: string | null
  userId?: string | null
  /** AIP-03: reuse the per-meeting locked model instead of the system default. */
  modelCtx?: ModelCtx
}

export async function answerWithContext({
  question,
  chunks,
  history = [],
  ctx,
}: {
  question: string
  chunks: RetrievedChunk[]
  history?: HistoryMessage[]
  ctx?: AnswerContext
}): Promise<AnswerResult> {
  const validChunkIds = new Set(chunks.map((c) => c.id))
  const { adapter, model } = ctx?.modelCtx
    ? resolveModel(ctx.modelCtx.provider, ctx.modelCtx.model)
    : getDefaultGenerationModel()

  // Capture the raw API text for the fallback — set inside parse() so it's
  // available in the catch block even when parse throws.
  let lastRawText = ''

  try {
    const result = await adapter.generateStructured({
      messages: buildPrompt(question, chunks, history.slice(-4)),
      schema: ANSWER_RESPONSE_SCHEMA,
      model,
      parse: (text) => {
        lastRawText = text
        const json = JSON.parse(stripFences(text)) as unknown
        return AnswerSchema.parse(json)
      },
      operation: 'chat',
      ctx,
    })

    return {
      answer: result.data.answer,
      citations: filterValidCitations(result.data.citations, validChunkIds),
    }
  } catch {
    return { answer: lastRawText || 'Unable to generate an answer.', citations: [] }
  }
}
