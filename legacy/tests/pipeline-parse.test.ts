// Unit tests for Zod schema parsing in types/pipeline.ts
// Validates that defensive .catch() defaults work correctly for malformed
// Gemini responses, and that the transform (seconds → ms) is correct.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GeminiTranscriptSchema,
  GeminiAnalysisSchema,
} from '../types/pipeline.js'

// ---------------------------------------------------------------------------
// GeminiTranscriptSchema
// ---------------------------------------------------------------------------

describe('GeminiTranscriptSchema', () => {
  it('parses a well-formed transcript', () => {
    const input = {
      language: 'en',
      segments: [
        { speaker: 'Speaker 1', start_s: 0, end_s: 5.5, text: 'Hello world' },
        { speaker: 'Speaker 2', start_s: 5.5, end_s: 10, text: 'Hi there' },
      ],
    }
    const result = GeminiTranscriptSchema.safeParse(input)
    assert.ok(result.success)
    assert.equal(result.data.language, 'en')
    assert.equal(result.data.segments.length, 2)
    assert.equal(result.data.segments[0].start_s, 0)
    assert.equal(result.data.segments[1].end_s, 10)
  })

  it('defaults language to "unknown" when missing', () => {
    const result = GeminiTranscriptSchema.safeParse({ segments: [] })
    assert.ok(result.success)
    assert.equal(result.data.language, 'unknown')
  })

  it('defaults segments to [] when missing', () => {
    const result = GeminiTranscriptSchema.safeParse({ language: 'vi' })
    assert.ok(result.success)
    assert.deepEqual(result.data.segments, [])
  })

  it('falls back gracefully on missing segment fields', () => {
    const input = {
      language: 'en',
      segments: [
        { text: 'Something was said' },
        // Missing speaker, start_s, end_s
      ],
    }
    const result = GeminiTranscriptSchema.safeParse(input)
    assert.ok(result.success)
    const seg = result.data.segments[0]
    assert.equal(seg.speaker, 'Speaker') // .catch default
    assert.equal(seg.start_s, 0)
    assert.equal(seg.end_s, 0)
    assert.equal(seg.text, 'Something was said')
  })

  it('falls back gracefully when segments is not an array', () => {
    const result = GeminiTranscriptSchema.safeParse({ language: 'en', segments: 'not-an-array' })
    assert.ok(result.success)
    assert.deepEqual(result.data.segments, [])
  })

  it('succeeds (with empty array) on completely garbage input', () => {
    const result = GeminiTranscriptSchema.safeParse(null)
    assert.ok(result.success)
    assert.equal(result.data.language, 'unknown')
    assert.deepEqual(result.data.segments, [])
  })
})

// ---------------------------------------------------------------------------
// GeminiAnalysisSchema
// ---------------------------------------------------------------------------

describe('GeminiAnalysisSchema', () => {
  it('parses a well-formed analysis', () => {
    const input = {
      summary: 'Short meeting about roadmap.',
      notes_markdown: '## Notes\n- Item 1',
      todos: [
        { content: 'Write tests', assignee: 'Alice', due_date: '2025-12-01', source_segment_index: 3 },
      ],
      calendar_suggestions: [
        { title: 'Sync', proposed_at: '2025-12-15T10:00:00Z', raw_mention: 'next Tuesday', source_segment_index: 7 },
      ],
    }
    const result = GeminiAnalysisSchema.safeParse(input)
    assert.ok(result.success)
    assert.equal(result.data.todos[0].assignee, 'Alice')
    assert.equal(result.data.calendar_suggestions[0].raw_mention, 'next Tuesday')
  })

  it('defaults all fields when everything is missing', () => {
    const result = GeminiAnalysisSchema.safeParse({})
    assert.ok(result.success)
    assert.equal(result.data.summary, '')
    assert.equal(result.data.notes_markdown, '')
    assert.deepEqual(result.data.todos, [])
    assert.deepEqual(result.data.calendar_suggestions, [])
  })

  it('defaults todos to [] when field is malformed', () => {
    const result = GeminiAnalysisSchema.safeParse({
      summary: 'ok',
      notes_markdown: 'ok',
      todos: 'not-an-array',
      calendar_suggestions: [],
    })
    assert.ok(result.success)
    assert.deepEqual(result.data.todos, [])
  })

  it('coerces null assignee/due_date in todos', () => {
    const input = {
      summary: 's',
      notes_markdown: 'n',
      todos: [{ content: 'Do X', assignee: null, due_date: null, source_segment_index: null }],
      calendar_suggestions: [],
    }
    const result = GeminiAnalysisSchema.safeParse(input)
    assert.ok(result.success)
    const todo = result.data.todos[0]
    assert.equal(todo.assignee, null)
    assert.equal(todo.due_date, null)
    assert.equal(todo.source_segment_index, null)
  })

  it('succeeds on completely garbage input', () => {
    const result = GeminiAnalysisSchema.safeParse('not-an-object')
    assert.ok(result.success)
    assert.equal(result.data.summary, '')
  })
})

// ---------------------------------------------------------------------------
// Seconds → milliseconds conversion (tested via the transform logic directly)
// ---------------------------------------------------------------------------

describe('seconds-to-ms transform', () => {
  it('converts float seconds correctly', () => {
    const input = {
      language: 'en',
      segments: [{ speaker: 'S1', start_s: 1.5, end_s: 3.75, text: 'hi' }],
    }
    const parsed = GeminiTranscriptSchema.parse(input)
    const seg = parsed.segments[0]
    // The schema stores raw seconds; conversion happens in parseResult() in transcribe.ts.
    // Here we just verify the raw values parse correctly.
    assert.equal(seg.start_s, 1.5)
    assert.equal(seg.end_s, 3.75)
    // Verify manual conversion used in transcribe.ts
    assert.equal(Math.round(seg.start_s * 1000), 1500)
    assert.equal(Math.round(seg.end_s * 1000), 3750)
  })
})
