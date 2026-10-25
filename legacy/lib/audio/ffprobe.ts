// SERVER ONLY — spawns the ffprobe process. Import only from /app/api or server /lib.
//
// Validates that a file (by local path or remote URL) contains a real audio stream
// and no video streams. Used in the upload pipeline before kicking off processing.
//
// ffprobe is typically installed alongside ffmpeg. If absent, validation is
// skipped with a warning (same graceful-degradation pattern as the ffmpeg transcode).

import { spawn } from 'node:child_process'
import { log, logger } from '@/lib/logger'
import { PipelineError } from '@/lib/gemini/errors'
import { ffprobeBinary } from '@/lib/audio/binaries'

// ---------------------------------------------------------------------------
// Pure helper — exported for unit testing
// ---------------------------------------------------------------------------

export interface ProbeResult {
  valid: boolean
  reason?: string
}

/**
 * Probe mode controls how video streams are handled:
 *  - 'audio-only'  (default) — rejects any file that has a video stream.
 *  - 'video'       — accepts video streams; still requires at least one audio
 *                    stream (needed for audio extraction).
 */
export type ProbeMode = 'audio-only' | 'video'

/**
 * Parse the JSON output of `ffprobe -print_format json -show_streams`.
 *
 * 'audio-only' rules (default):
 *   • Must have ≥1 stream with codec_type "audio"
 *   • Must have 0 streams with codec_type "video"
 *
 * 'video' rules:
 *   • Must have ≥1 stream with codec_type "audio" (needed to extract audio)
 *   • Video streams are accepted (expected for .mp4 / .mov / etc.)
 *
 * Other stream types (data, attachment, subtitle) are ignored in both modes.
 */
export function parseProbeResult(json: unknown, mode: ProbeMode = 'audio-only'): ProbeResult {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, reason: 'ffprobe output is not a JSON object' }
  }

  const obj = json as Record<string, unknown>
  if (!Array.isArray(obj.streams)) {
    return { valid: false, reason: 'ffprobe output has no streams array' }
  }

  const streams = obj.streams as Array<Record<string, unknown>>

  const hasVideo = streams.some(
    (s) => typeof s.codec_type === 'string' && s.codec_type.toLowerCase() === 'video',
  )

  if (mode === 'audio-only' && hasVideo) {
    return { valid: false, reason: 'File contains a video stream — only audio-only files are supported' }
  }

  const hasAudio = streams.some(
    (s) => typeof s.codec_type === 'string' && s.codec_type.toLowerCase() === 'audio',
  )
  if (!hasAudio) {
    return { valid: false, reason: 'File contains no audio stream' }
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

async function runFfprobe(target: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeBinary(), [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      target,
    ], { stdio: 'pipe' })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-300)}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`ffprobe returned non-JSON stdout: ${stdout.slice(0, 200)}`))
      }
    })

    proc.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Check whether ffprobe is available on PATH.
 */
export async function isFfprobeAvailable(): Promise<boolean> {
  try {
    await runFfprobe('-version').catch(() => null)
    return true
  } catch {
    return false
  }
}

async function runValidation(filePathOrUrl: string, mode: ProbeMode): Promise<void> {
  let probeJson: unknown
  try {
    probeJson = await runFfprobe(filePathOrUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)

    // ffprobe not installed → skip validation gracefully
    if (
      msg.includes('ENOENT') ||
      msg.includes('not found') ||
      msg.includes('spawn ffprobe')
    ) {
      logger.warn(
        '[ffprobe] ffprobe not found in PATH — skipping stream validation. ' +
          'Install ffprobe for server-side file type checking.',
      )
      return
    }

    throw new PipelineError(`ffprobe failed to analyse the file: ${msg}`)
  }

  log('[ffprobe] probe complete, parsing streams')
  const result = parseProbeResult(probeJson, mode)
  if (!result.valid) {
    throw new PipelineError(`Invalid file: ${result.reason}`)
  }
  log(`[ffprobe] stream validation passed (mode=${mode})`)
}

/**
 * Validate that `filePathOrUrl` is an audio-only file (no video streams).
 * Used for files uploaded with source='uploaded'.
 *
 * Throws `PipelineError` on failure. Skips gracefully if ffprobe is absent.
 */
export async function validateAudioStream(filePathOrUrl: string): Promise<void> {
  return runValidation(filePathOrUrl, 'audio-only')
}

/**
 * Validate that `filePathOrUrl` contains at least one audio stream.
 * Video streams are permitted (expected for .mp4 / .mov / etc.).
 * Used for files uploaded with source='video' before audio extraction.
 *
 * Throws `PipelineError` if no audio track is found (e.g. muted video).
 * Skips gracefully if ffprobe is absent.
 */
export async function validateVideoAudioStream(filePathOrUrl: string): Promise<void> {
  return runValidation(filePathOrUrl, 'video')
}

// ---------------------------------------------------------------------------
// Duration extraction (QUO-02: pre-flight quota estimate)
// ---------------------------------------------------------------------------

async function runFfprobeDuration(filePath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobeBinary(), [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_entries', 'format=duration',
      filePath,
    ], { stdio: 'pipe' })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-200)}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`ffprobe returned non-JSON stdout: ${stdout.slice(0, 100)}`))
      }
    })
    proc.on('error', (err) => { reject(err) })
  })
}

/**
 * Parse the `format.duration` field from `ffprobe -show_entries format=duration` output.
 * Exported for unit testing.
 *
 * @returns Duration in seconds (float), or 0 if unavailable/invalid.
 */
export function parseDurationFromProbe(json: unknown): number {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 0
  const obj = json as Record<string, unknown>
  const format = obj.format as Record<string, unknown> | undefined
  if (!format || typeof format.duration !== 'string') return 0
  const seconds = parseFloat(format.duration)
  return isFinite(seconds) && seconds > 0 ? seconds : 0
}

/**
 * Return the audio duration of a local file in seconds via ffprobe.
 *
 * Used by QUO-02 to estimate audio cost before calling Speechmatics.
 * Falls back to 0 when ffprobe is absent or the format has no duration header
 * (e.g. bare WebM without container duration) — callers use `meeting.duration_seconds`
 * as a secondary fallback.
 *
 * @param filePath  Absolute path to the audio file on disk.
 * @returns         Duration in seconds, or 0 on any failure.
 */
export async function getAudioDurationSeconds(filePath: string): Promise<number> {
  try {
    const json = await runFfprobeDuration(filePath)
    return parseDurationFromProbe(json)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes('ENOENT') ||
      msg.includes('not found') ||
      msg.includes('spawn ffprobe')
    ) {
      logger.warn('[ffprobe] ffprobe not found — audio duration estimate unavailable')
    } else {
      logger.warn('[ffprobe] duration probe failed (non-fatal)', { detail: msg })
    }
    return 0
  }
}
