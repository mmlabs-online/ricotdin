// Audio transcoding and chunking for Gemini.
//
// Gemini natively supports audio/webm (and mp4, wav, ogg, flac, etc.), so
// ffmpeg is OPTIONAL for short recordings. When available, we transcode to
// mp3 (mono 16kHz 64kbps) because it's smaller — useful for large files and
// free-tier quota. When ffmpeg is absent, the original webm is sent directly.
//
// For long recordings (> 28 min) ffmpeg IS required: Gemini has a per-request
// audio limit and the file must be split into chunks before uploading.
//
// The tmpDir passed by processMeeting owns all intermediate files; the caller's
// finally block cleans the whole directory after processing.

import { extname } from 'node:path'
import { log } from '@/lib/logger'
import { transcribeAudio } from '@/lib/gemini/transcribe'
import { isFfmpegAvailable, transcodeForGemini, transcodeAndChunk } from '@/lib/audio/transcode'
import { PipelineError } from '@/lib/gemini/errors'
import type { TranscriptResult } from '@/types/pipeline'

// Trigger chunking when duration exceeds 28 min (conservative, under the
// ~30 min Gemini per-request audio limit).
const LONG_AUDIO_THRESHOLD_SECS = 28 * 60

// Each chunk is ~25 minutes — headroom for encoding variances.
const CHUNK_DURATION_SECS = 25 * 60

function mimeTypeFromPath(path: string): string {
  const ext = extname(path).toLowerCase()
  const map: Record<string, string> = {
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
  }
  return map[ext] ?? 'audio/webm'
}

/**
 * Transcribe the audio at `audioPath` (any format, typically .webm from the browser).
 *
 * • Short recordings (≤ 28 min): transcode to mp3 if ffmpeg is available
 *   (smaller upload); otherwise send the original file directly — Gemini
 *   supports audio/webm natively.
 * • Long recordings (> 28 min): requires ffmpeg. Transcode + split in one
 *   pass, transcribe each chunk, stitch segments with corrected time offsets.
 *
 * @param audioPath       Absolute path to the source audio file (e.g. .webm).
 * @param durationSeconds Known duration in seconds (0 = unknown → short path).
 * @param tmpDir          Directory for all intermediate files (caller cleans up).
 */
export async function transcribeWithChunking(
  audioPath: string,
  durationSeconds: number,
  tmpDir: string,
): Promise<TranscriptResult> {
  if (durationSeconds <= LONG_AUDIO_THRESHOLD_SECS) {
    if (await isFfmpegAvailable()) {
      log(
        `[audioChunk] duration ${Math.round(durationSeconds / 60)}m — transcoding to mp3`,
      )
      const mp3Path = await transcodeForGemini(audioPath, tmpDir)
      return transcribeAudio(mp3Path, 'audio/mp3')
    }
    const mimeType = mimeTypeFromPath(audioPath)
    log(
      `[audioChunk] duration ${Math.round(durationSeconds / 60)}m — sending ${mimeType} directly (ffmpeg not installed)`,
    )
    return transcribeAudio(audioPath, mimeType)
  }

  log(
    `[audioChunk] duration ${Math.round(durationSeconds / 60)}m — long audio, checking ffmpeg`,
  )

  if (!(await isFfmpegAvailable())) {
    throw new PipelineError(
      `Recording is ${Math.round(durationSeconds / 60)} minutes, which exceeds the ` +
        `30-minute per-request limit for Gemini audio. ` +
        `Install ffmpeg to enable automatic splitting of long recordings. ` +
        `(ffmpeg was not found in PATH)`,
    )
  }

  log(
    `[audioChunk] transcoding + splitting into ~${CHUNK_DURATION_SECS / 60}-min mp3 chunks`,
  )
  const chunkFiles = await transcodeAndChunk(audioPath, tmpDir, CHUNK_DURATION_SECS)
  log(`[audioChunk] ${chunkFiles.length} chunk(s) produced`)

  const allSegments: TranscriptResult['segments'] = []
  let language = 'unknown'
  let offsetMs = 0

  for (let i = 0; i < chunkFiles.length; i++) {
    log(`[audioChunk] transcribing chunk ${i + 1}/${chunkFiles.length}`)
    const chunkResult = await transcribeAudio(chunkFiles[i], 'audio/mp3')

    if (i === 0) language = chunkResult.language

    for (const seg of chunkResult.segments) {
      allSegments.push({
        ...seg,
        start_ms: seg.start_ms + offsetMs,
        end_ms: seg.end_ms + offsetMs,
      })
    }

    offsetMs += CHUNK_DURATION_SECS * 1_000
  }

  return { language, segments: allSegments }
}
