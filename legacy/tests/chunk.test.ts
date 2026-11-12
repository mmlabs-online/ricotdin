// Unit tests for lib/pipeline/chunk.ts
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chunkSegments } from '../lib/pipeline/chunk.js'
import type { TranscriptResult } from '../types/pipeline.js'

type Seg = TranscriptResult['segments'][number]

function seg(i: number, text: string, speaker = 'Speaker 1'): Seg {
  return { speaker, start_ms: i * 1000, end_ms: (i + 1) * 1000, text }
}

describe('chunkSegments', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(chunkSegments([]), [])
  })

  it('returns a single chunk for a short transcript', () => {
    const segments = [seg(0, 'Hello world'), seg(1, 'How are you')]
    const chunks = chunkSegments(segments)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].chunk_index, 0)
    assert.equal(chunks[0].start_ms, 0)
    assert.equal(chunks[0].end_ms, 2000)
    assert.ok(chunks[0].content.includes('Hello world'))
    assert.ok(chunks[0].content.includes('How are you'))
  })

  it('chunk_index is sequential and 0-based', () => {
    // Generate enough text to force multiple chunks (>1200 chars per chunk)
    const longText = 'a'.repeat(500)
    const segments = Array.from({ length: 10 }, (_, i) => seg(i, longText))
    const chunks = chunkSegments(segments)
    assert.ok(chunks.length > 1, 'should produce multiple chunks')
    chunks.forEach((c, idx) => {
      assert.equal(c.chunk_index, idx)
    })
  })

  it('chunks are non-empty and cover all segments', () => {
    const shortText = 'word'.repeat(10) // 40 chars, well under target
    const segments = Array.from({ length: 20 }, (_, i) => seg(i, shortText))
    const chunks = chunkSegments(segments)
    assert.ok(chunks.length >= 1)

    // Every segment's text should appear in at least one chunk
    for (const s of segments) {
      const found = chunks.some((c) => c.content.includes(s.text))
      assert.ok(found, `segment text "${s.text}" not found in any chunk`)
    }
  })

  it('start_ms and end_ms reflect the first and last segments in each chunk', () => {
    const segments = Array.from({ length: 5 }, (_, i) => seg(i, 'hello'))
    const chunks = chunkSegments(segments)
    for (const chunk of chunks) {
      assert.ok(chunk.start_ms <= chunk.end_ms, 'start_ms should be <= end_ms')
      assert.ok(chunk.start_ms >= 0)
    }
  })

  it('token_count is positive and roughly proportional to content length', () => {
    const segments = [seg(0, 'a'.repeat(400))]
    const chunks = chunkSegments(segments)
    assert.ok(chunks[0].token_count > 0)
    // content length / 4 ≈ token_count (within 2x)
    const approx = Math.ceil(chunks[0].content.length / 4)
    assert.ok(
      Math.abs(chunks[0].token_count - approx) <= 2,
      `token_count ${chunks[0].token_count} should be ~${approx}`,
    )
  })

  it('speaker labels are included in chunk content', () => {
    const segments = [
      seg(0, 'I have a question', 'Speaker 1'),
      seg(1, 'Go ahead', 'Speaker 2'),
    ]
    const chunks = chunkSegments(segments)
    assert.ok(chunks[0].content.includes('Speaker 1'))
    assert.ok(chunks[0].content.includes('Speaker 2'))
  })

  it('overlap: consecutive chunks share at least one segment when chunking many short segs', () => {
    // Each segment is tiny so many fit in one chunk — force splitting with long segs
    const longText = 'x'.repeat(700) // each segment ~700 chars, target is 1200
    const segments = Array.from({ length: 6 }, (_, i) => seg(i, longText))
    const chunks = chunkSegments(segments)
    assert.ok(chunks.length >= 2)

    // Consecutive chunks should share at least one segment text (overlap)
    for (let i = 1; i < chunks.length; i++) {
      const prevLines = new Set(chunks[i - 1].content.split('\n'))
      const currLines = chunks[i].content.split('\n')
      const hasOverlap = currLines.some((line) => prevLines.has(line))
      assert.ok(hasOverlap, `chunks ${i - 1} and ${i} should share an overlapping segment`)
    }
  })

  it('single very long segment produces exactly one chunk', () => {
    // A single segment longer than the target — must still produce a chunk
    const segments = [seg(0, 'z'.repeat(5000))]
    const chunks = chunkSegments(segments)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].chunk_index, 0)
  })
})
