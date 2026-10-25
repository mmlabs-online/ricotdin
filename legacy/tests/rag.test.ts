// Unit tests for the RAG retrieval + answer generation logic.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SIMILARITY_FLOOR, MATCH_COUNT } from '../lib/rag/retrieve.js'
import { filterValidCitations } from '../lib/gemini/answer.js'
import type { Citation } from '../types/database.js'

// ---------------------------------------------------------------------------
// Retrieval constants
// ---------------------------------------------------------------------------

describe('retrieve constants', () => {
  it('SIMILARITY_FLOOR is between 0 and 1 exclusive', () => {
    assert.ok(SIMILARITY_FLOOR > 0 && SIMILARITY_FLOOR < 1, `SIMILARITY_FLOOR=${SIMILARITY_FLOOR}`)
  })

  it('MATCH_COUNT is a positive integer in a sensible range', () => {
    assert.ok(Number.isInteger(MATCH_COUNT) && MATCH_COUNT >= 4 && MATCH_COUNT <= 20)
  })
})

// ---------------------------------------------------------------------------
// Similarity floor filtering (mirrors the filter in retrieveContext)
// ---------------------------------------------------------------------------

describe('similarity floor filtering', () => {
  const floor = SIMILARITY_FLOOR

  it('keeps chunks at or above the floor', () => {
    const chunks = [
      { id: 'a', similarity: floor },
      { id: 'b', similarity: floor + 0.1 },
      { id: 'c', similarity: 1.0 },
    ]
    const result = chunks.filter((c) => c.similarity >= floor)
    assert.equal(result.length, 3)
  })

  it('drops chunks below the floor', () => {
    const chunks = [
      { id: 'x', similarity: floor - 0.01 },
      { id: 'y', similarity: 0 },
      { id: 'z', similarity: floor - 0.3 },
    ]
    const result = chunks.filter((c) => c.similarity >= floor)
    assert.equal(result.length, 0)
  })

  it('returns empty array when all chunks are below the floor', () => {
    const chunks = [{ id: 'a', similarity: 0.1 }]
    const result = chunks.filter((c) => c.similarity >= floor)
    assert.deepEqual(result, [])
  })

  it('preserves order of chunks above the floor', () => {
    const chunks = [
      { id: 'first', similarity: 0.9 },
      { id: 'second', similarity: 0.7 },
      { id: 'below', similarity: 0.1 },
      { id: 'third', similarity: 0.6 },
    ]
    const result = chunks.filter((c) => c.similarity >= floor)
    assert.deepEqual(
      result.map((c) => c.id),
      ['first', 'second', 'third'],
    )
  })
})

// ---------------------------------------------------------------------------
// Citation validation — invented chunk_ids must be dropped
// A user can never see chunks from another user's meetings; if the model
// hallucinates a chunk_id it was never given, we must drop that citation.
// ---------------------------------------------------------------------------

describe('filterValidCitations', () => {
  function makeCitation(chunkId: string): Citation {
    return { chunk_id: chunkId, meeting_id: 'meet-1', start_ms: 0, end_ms: 5000 }
  }

  it('keeps citations whose chunk_id is in the valid set', () => {
    const valid = new Set(['chunk-1', 'chunk-2'])
    const citations = [makeCitation('chunk-1'), makeCitation('chunk-2')]
    const result = filterValidCitations(citations, valid)
    assert.equal(result.length, 2)
  })

  it('drops citations with invented (unknown) chunk_ids', () => {
    const valid = new Set(['chunk-1'])
    const citations = [makeCitation('chunk-1'), makeCitation('invented-id')]
    const result = filterValidCitations(citations, valid)
    assert.equal(result.length, 1)
    assert.equal(result[0].chunk_id, 'chunk-1')
  })

  it('returns empty array when all citations are invented', () => {
    const valid = new Set(['real-chunk'])
    const citations = [makeCitation('fake-1'), makeCitation('fake-2')]
    const result = filterValidCitations(citations, valid)
    assert.deepEqual(result, [])
  })

  it('returns empty array when input is empty', () => {
    const result = filterValidCitations([], new Set(['chunk-1']))
    assert.deepEqual(result, [])
  })

  it('preserves all fields of valid citations', () => {
    const c: Citation = { chunk_id: 'c1', meeting_id: 'meet-42', start_ms: 3000, end_ms: 9000 }
    const result = filterValidCitations([c], new Set(['c1']))
    assert.deepEqual(result[0], c)
  })

  // RLS scoping assertion: the function is the last gate before citations reach
  // the client. A citation whose chunk_id was never retrieved (and therefore
  // never passed to answerWithContext) cannot survive this filter — ensuring
  // that even if the model hallucinates an ID from another user's meeting,
  // it is removed before it can surface in the UI.
  it('enforces RLS scoping: citations referencing chunks not in the retrieval result are always dropped', () => {
    const retrievedChunkIds = new Set(['my-chunk-a', 'my-chunk-b'])
    // Model hallucinated a chunk from a different user's meeting
    const otherUserCitation = makeCitation('other-user-chunk-xyz')
    const myCitation = makeCitation('my-chunk-a')

    const result = filterValidCitations([myCitation, otherUserCitation], retrievedChunkIds)
    assert.equal(result.length, 1)
    assert.equal(result[0].chunk_id, 'my-chunk-a')
    assert.ok(!result.some((c) => c.chunk_id === 'other-user-chunk-xyz'))
  })
})
