// SERVER ONLY — retrieves transcript chunks semantically relevant to a user query.
//
// IMPORTANT: always pass a user-scoped client (createUserClient), never the
// service-role client. The match_transcript_chunks RPC is executed under the
// caller's JWT so RLS on transcript_chunks scopes results to the user's own
// meetings. Using the service role here would leak other users' data.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { embedChunks } from '@/lib/gemini/embed'
import { EMBEDDING_DIMENSION } from '@/lib/gemini/client'
import { logger, describeError } from '@/lib/logger'

export const MATCH_COUNT = 8
// Chunks below this cosine similarity are dropped as off-topic noise.
export const SIMILARITY_FLOOR = 0.5

export interface RetrievedChunk {
  id: string
  meeting_id: string
  content: string
  start_ms: number
  end_ms: number
  similarity: number
}

/**
 * Embed the query, call match_transcript_chunks RPC, and apply a similarity floor.
 *
 * @param query     - The user's natural-language question
 * @param userClient - A Supabase client created with the user's JWT (RLS applies)
 * @param meetingIds - null = global; [id] = single meeting; [...ids] = folder scope
 * @param userId    - Optional; forwarded to embedChunks for usage attribution
 */
export async function retrieveContext({
  query,
  userClient,
  meetingIds = null,
  userId,
}: {
  query: string
  userClient: SupabaseClient<Database>
  meetingIds?: string[] | null
  userId?: string | null
}): Promise<RetrievedChunk[]> {
  // For usage attribution, pass meetingId only when scoped to exactly one meeting.
  const singleMeetingId = meetingIds?.length === 1 ? meetingIds[0] : undefined

  // ── Step 1: embed the query (Gemini) ───────────────────────────────────────
  let queryEmbedding: number[]
  try {
    const embeddings = await embedChunks([query], {
      operation: 'embed-query',
      meetingId: singleMeetingId,
      userId,
    })
    queryEmbedding = embeddings[0]
  } catch (err) {
    // Surface the EXACT Gemini error (unwrapped) — otherwise it stringifies to
    // "[object Object]" and the real cause (429, key, quota, model) is lost.
    logger.error('[rag] query embed failed', {
      step: 'embed-query',
      meetingId: singleMeetingId,
      userId: userId ?? undefined,
      detail: describeError(err),
    })
    throw err
  }

  if (queryEmbedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Query embedding dimension ${queryEmbedding.length} !== stored dimension ${EMBEDDING_DIMENSION}`,
    )
  }

  // ── Step 2: vector search (Postgres RPC, RLS-scoped) ───────────────────────
  const { data, error } = await userClient.rpc('match_transcript_chunks', {
    query_embedding: queryEmbedding,
    match_count: MATCH_COUNT,
    filter_meeting_ids: meetingIds ?? null,
  })

  if (error) {
    logger.error('[rag] match_transcript_chunks RPC failed', {
      step: 'rpc',
      meetingId: singleMeetingId,
      detail: describeError(error),
    })
    throw new Error(`Retrieval RPC failed: ${error.message}`)
  }

  // ── Step 3: apply similarity floor ─────────────────────────────────────────
  const rows = data ?? []
  const kept = rows.filter((c) => c.similarity >= SIMILARITY_FLOOR)

  // Diagnostic: distinguish "RPC returned nothing" (no chunks / wrong scope)
  // from "everything cut by the floor" (retrieval quality / floor too high).
  logger.info('[rag] retrieval result', {
    step: 'retrieve',
    meetingId: singleMeetingId,
    scope: meetingIds === null ? 'global' : `${meetingIds.length} meeting(s)`,
    rpcRows: rows.length,
    kept: kept.length,
    floor: SIMILARITY_FLOOR,
    topSimilarities: rows.slice(0, 5).map((c) => Number(c.similarity.toFixed(3))),
  })

  return kept
}
