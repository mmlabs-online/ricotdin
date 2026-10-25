// SERVER ONLY — reads Gemini API keys. Import only from /app/api or server /lib.
//
// Batched text embedding using gemini-embedding-001 at 768 dimensions (must
// match the vector(768) column in transcript_chunks and EMBEDDING_DIMENSION).
//
// Each batch is a separate geminiPool.call() so a 429 on batch N doesn't
// force re-embedding batches 0..N-1.

import { log } from '@/lib/logger'
import { GEMINI_EMBEDDING_MODEL, EMBEDDING_DIMENSION } from './client'
import { geminiPool } from './pool'
import { PipelineError } from './errors'
import { logUsage } from '@/lib/usage/logUsage'

// Gemini embedding API batch limit (conservative — free tier may be lower).
const BATCH_SIZE = 100

export interface EmbedContext {
  operation?: string      // 'embed' (pipeline) | 'embed-query' (RAG retrieval)
  meetingId?: string | null
  userId?: string | null
}

/**
 * Embed an array of texts using the Gemini embedding model.
 * Returns one 768-dimension float array per input text, in the same order.
 *
 * @param texts  Texts to embed.
 * @param ctx    Optional attribution context for usage logging.
 */
export async function embedChunks(texts: string[], ctx?: EmbedContext): Promise<number[][]> {
  if (texts.length === 0) return []

  const all: number[][] = []
  const operation = ctx?.operation ?? 'embed'

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    log(
      `[embed] embedding batch ${Math.floor(i / BATCH_SIZE) + 1} ` +
        `(${batch.length} chunks, total so far ${i})`,
    )

    let usedKeyId: string | null = null
    const response = await geminiPool.call((ai, keyId) => {
      usedKeyId = keyId
      return ai.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: batch,
        config: { outputDimensionality: EMBEDDING_DIMENSION },
      })
    })

    // The Gemini embedding API may not return usageMetadata; use batch size as proxy.
    const meta = (response as Record<string, unknown>).usageMetadata as
      | { totalTokenCount?: number; promptTokenCount?: number }
      | undefined
    const totalTokens = meta?.totalTokenCount ?? undefined
    logUsage({
      provider: 'gemini-embedding', model: GEMINI_EMBEDDING_MODEL, operation,
      unit: 'tokens',
      quantity: totalTokens ?? batch.length,
      input_tokens: meta?.promptTokenCount ?? undefined,
      total_tokens: totalTokens,
      meeting_id: ctx?.meetingId, user_id: ctx?.userId, key_id: usedKeyId,
    })

    const embeddings = response.embeddings
    if (!embeddings || embeddings.length !== batch.length) {
      throw new PipelineError(
        `Gemini embed: expected ${batch.length} embeddings, got ${embeddings?.length ?? 0}`,
      )
    }

    for (const emb of embeddings) {
      const values = emb.values
      if (!values || values.length !== EMBEDDING_DIMENSION) {
        throw new PipelineError(
          `Gemini embed: wrong dimension ${values?.length ?? 0}, expected ${EMBEDDING_DIMENSION}`,
        )
      }
      all.push(values)
    }
  }

  return all
}
