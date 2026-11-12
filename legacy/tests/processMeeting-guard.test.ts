// Unit tests for the empty-result guards in lib/pipeline/guards.ts.
//
// These guards are what prevents a meeting from reaching status='done' with an
// empty transcript or analysis. Testing the pure helpers directly avoids the
// need to mock Supabase + Gemini for this logic.
//
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertTranscriptHasSpeech, assertAnalysisHasContent } from '../lib/pipeline/guards.js'
import type { TranscriptResult, AnalysisResult } from '../types/pipeline.js'

// ---------------------------------------------------------------------------
// assertTranscriptHasSpeech
// ---------------------------------------------------------------------------

describe('assertTranscriptHasSpeech', () => {
  it('throws PipelineError for an empty segments array', () => {
    const transcript: TranscriptResult = { language: 'und', segments: [] }
    assert.throws(
      () => assertTranscriptHasSpeech(transcript),
      { name: 'PipelineError', message: 'transcription returned no speech' },
    )
  })

  it('throws PipelineError when all segment text is whitespace', () => {
    const transcript: TranscriptResult = {
      language: 'en',
      segments: [
        { speaker: 'Speaker 1', start_ms: 0, end_ms: 1000, text: '   ' },
        { speaker: 'Speaker 2', start_ms: 1000, end_ms: 2000, text: '\n\t' },
      ],
    }
    assert.throws(
      () => assertTranscriptHasSpeech(transcript),
      { name: 'PipelineError', message: 'transcription returned no speech' },
    )
  })

  it('does not throw when at least one segment has real text', () => {
    const transcript: TranscriptResult = {
      language: 'en',
      segments: [{ speaker: 'Speaker 1', start_ms: 0, end_ms: 1000, text: 'Hello world' }],
    }
    assert.doesNotThrow(() => assertTranscriptHasSpeech(transcript))
  })

  it('does not throw when text is present alongside whitespace segments', () => {
    const transcript: TranscriptResult = {
      language: 'en',
      segments: [
        { speaker: 'Speaker 1', start_ms: 0, end_ms: 500, text: '  ' },
        { speaker: 'Speaker 1', start_ms: 500, end_ms: 1500, text: 'Real speech here' },
      ],
    }
    assert.doesNotThrow(() => assertTranscriptHasSpeech(transcript))
  })
})

// ---------------------------------------------------------------------------
// assertAnalysisHasContent
// ---------------------------------------------------------------------------

describe('assertAnalysisHasContent', () => {
  const empty: AnalysisResult = {
    summary: '',
    notes_markdown: '',
    todos: [],
    calendar_suggestions: [],
  }

  it('throws PipelineError when both summary and notes_markdown are empty strings', () => {
    assert.throws(
      () => assertAnalysisHasContent(empty),
      { name: 'PipelineError', message: 'analysis returned empty summary and notes' },
    )
  })

  it('throws PipelineError when both fields are whitespace only', () => {
    const analysis: AnalysisResult = { ...empty, summary: '   ', notes_markdown: '\n\t\n' }
    assert.throws(
      () => assertAnalysisHasContent(analysis),
      { name: 'PipelineError', message: 'analysis returned empty summary and notes' },
    )
  })

  it('does not throw when summary is non-empty', () => {
    const analysis: AnalysisResult = { ...empty, summary: 'Short meeting about roadmap.' }
    assert.doesNotThrow(() => assertAnalysisHasContent(analysis))
  })

  it('does not throw when notes_markdown is non-empty (summary may be empty)', () => {
    const analysis: AnalysisResult = { ...empty, notes_markdown: '## Notes\n- Item 1' }
    assert.doesNotThrow(() => assertAnalysisHasContent(analysis))
  })

  it('does not throw when both summary and notes_markdown are non-empty', () => {
    const analysis: AnalysisResult = {
      ...empty,
      summary: 'Meeting about Q3 roadmap.',
      notes_markdown: '## Decisions\n- Ship by EOQ',
    }
    assert.doesNotThrow(() => assertAnalysisHasContent(analysis))
  })
})
