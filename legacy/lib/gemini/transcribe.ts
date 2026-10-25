// SERVER ONLY — reads Gemini API keys. Import only from /app/api or server /lib.
//
// Step A of the pipeline: upload audio via the Gemini Files API, call Flash in
// JSON mode for full-meeting transcription with speaker diarization, validate
// the result with Zod, delete the uploaded file, and return TranscriptResult.
//
// The entire upload → generate → delete sequence runs inside a single
// geminiPool.call() so the same API key is used throughout. Gemini Files are
// scoped to the key that uploaded them — rotating mid-session would break access.
// If a transport error occurs at any point the pool retries the whole sequence
// with the next available key (including re-uploading the file).

import { stat } from 'node:fs/promises'
import { log, logger } from '@/lib/logger'
import { Type, type Schema, type Part } from '@google/genai'
import { GEMINI_MODEL } from './client'
import { geminiPool } from './pool'
import { PipelineError } from './errors'
import {
  GeminiTranscriptSchema,
  type TranscriptResult,
} from '@/types/pipeline'

// Set GEMINI_DEBUG=1 to log raw API responses and uploaded file metadata.
// Useful for diagnosing empty transcripts or unexpected Gemini output.
const GEMINI_DEBUG = process.env.GEMINI_DEBUG === '1'

// ---------------------------------------------------------------------------
// Gemini response schema (JSON Schema passed to the API)
// ---------------------------------------------------------------------------

const TRANSCRIPT_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    language: { type: Type.STRING, description: 'BCP-47 language code, e.g. "en" or "vi"' },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING, description: 'Speaker label, e.g. "Speaker 1"' },
          start_s: { type: Type.NUMBER, description: 'Segment start time in seconds' },
          end_s: { type: Type.NUMBER, description: 'Segment end time in seconds' },
          text: { type: Type.STRING, description: 'Verbatim transcript text' },
        },
        required: ['speaker', 'start_s', 'end_s', 'text'],
      },
    },
  },
  required: ['language', 'segments'],
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const TRANSCRIBE_PROMPT = `Transcribe this meeting audio in full detail.

For each segment of speech:
- Identify each distinct speaker as "Speaker 1", "Speaker 2", etc. (speaker diarization)
- Provide start and end timestamps in seconds as decimal numbers (e.g. 12.5)
- Transcribe the text verbatim — do not paraphrase or summarize

The "language" field should be the BCP-47 primary language code (e.g. "en", "vi", "fr").
Include ALL speech in the recording — skip nothing.

Note: timestamps are approximate estimates. Provide them even when uncertain.`

const TRANSCRIBE_PROMPT_STRICT = TRANSCRIBE_PROMPT +
  '\n\nReturn ONLY valid JSON. No markdown, no code fences, no explanation.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

function parseResult(raw: string): TranscriptResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    throw new PipelineError(
      `Gemini transcript: JSON.parse failed. First 300 chars: ${raw.slice(0, 300)}`,
    )
  }

  const result = GeminiTranscriptSchema.safeParse(parsed)
  if (!result.success) {
    throw new PipelineError(
      `Gemini transcript: schema validation failed: ${result.error.message}`,
    )
  }

  const { language, segments } = result.data
  log(`[transcribe] parsed: language=${language}, segments=${segments.length}`)
  if (segments.length === 0) {
    logger.warn('[transcribe] Gemini returned 0 segments — audio may be silent, too short, or in an unsupported codec')
  }
  return {
    language,
    // Convert seconds → ms. Gemini timestamps are approximate; treat gracefully.
    segments: segments.map((s) => ({
      speaker: s.speaker || 'Speaker',
      start_ms: Math.round(s.start_s * 1000),
      end_ms: Math.round(s.end_s * 1000),
      text: s.text,
    })),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload `audioPath` to the Gemini Files API, transcribe with speaker labels
 * and timestamps, validate, then delete the remote file.
 *
 * @param audioPath  Absolute path to the audio file on disk.
 * @param mimeType   MIME type of the audio (defaults to 'audio/webm').
 */
export async function transcribeAudio(
  audioPath: string,
  mimeType = 'audio/webm',
): Promise<TranscriptResult> {
  return geminiPool.call(async (ai) => {
    // 1. Upload to Gemini Files API (temporary staging, ~48h retention)
    if (GEMINI_DEBUG) {
      const fileInfo = await stat(audioPath).catch(() => null)
      log(
        `[transcribe:debug] uploading — path=${audioPath} mime=${mimeType}` +
          (fileInfo ? ` size=${fileInfo.size}bytes` : ' (stat failed)'),
      )
    } else {
      log(`[transcribe] uploading ${audioPath} (${mimeType})`)
    }

    const geminiFile = await ai.files.upload({
      file: audioPath,
      config: { mimeType, displayName: 'meeting-audio' },
    })

    if (!geminiFile.uri) {
      throw new PipelineError('Gemini file upload succeeded but returned no URI')
    }

    const filePart: Part = {
      fileData: { fileUri: geminiFile.uri, mimeType: geminiFile.mimeType ?? mimeType },
    }

    try {
      // 2. First transcription attempt
      log('[transcribe] calling Gemini Flash for transcription')
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [filePart, { text: TRANSCRIBE_PROMPT }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
        },
      })

      if (GEMINI_DEBUG) {
        log(
          `[transcribe:debug] raw response text (first 800 chars): ` +
            (response.text ?? '(empty)').slice(0, 800),
        )
      }

      try {
        return parseResult(response.text ?? '')
      } catch (parseErr) {
        // 3. Retry once with a stricter prompt if parsing failed.
        // This is a prompt-level retry on the same key — not a transport retry.
        // PipelineError from parseResult is classified as 'bad-request' by the
        // pool, so if this second attempt also fails to parse, it surfaces
        // immediately without further key rotation.
        logger.warn('[transcribe] first parse failed; retrying with strict prompt', { detail: String(parseErr) })
        const response2 = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [filePart, { text: TRANSCRIBE_PROMPT_STRICT }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: TRANSCRIPT_RESPONSE_SCHEMA,
          },
        })
        if (GEMINI_DEBUG) {
          log(
            `[transcribe:debug] retry raw response text (first 800 chars): ` +
              (response2.text ?? '(empty)').slice(0, 800),
          )
        }
        return parseResult(response2.text ?? '')
      }
    } finally {
      // 4. Delete the uploaded file. It auto-expires in ~48h, but be proactive.
      if (geminiFile.name) {
        ai.files.delete({ name: geminiFile.name }).catch((err: unknown) => {
          logger.warn('[transcribe] failed to delete Gemini file', { detail: String(err) })
        })
      }
    }
  })
}
