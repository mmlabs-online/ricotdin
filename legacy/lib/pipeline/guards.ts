// Pure validation helpers used by processMeeting to detect silent failures from
// the Gemini API. Exported so they can be unit-tested without mocking I/O.

import { PipelineError } from '@/lib/gemini/errors'
import type { TranscriptResult, AnalysisResult } from '@/types/pipeline'

/**
 * Throw if the transcript has no segments or all segment text is whitespace.
 * A meeting must never reach 'done' with an empty transcript.
 */
export function assertTranscriptHasSpeech(transcript: TranscriptResult): void {
  const combinedText = transcript.segments.map((s) => s.text).join(' ').trim()
  if (transcript.segments.length === 0 || !combinedText) {
    throw new PipelineError('transcription returned no speech')
  }
}

/**
 * Throw if the analysis produced neither a summary nor any notes.
 * An empty summary+notes is a signal that the Gemini response was unusable.
 */
export function assertAnalysisHasContent(analysis: AnalysisResult): void {
  if (!analysis.summary.trim() && !analysis.notes_markdown.trim()) {
    throw new PipelineError('analysis returned empty summary and notes')
  }
}
