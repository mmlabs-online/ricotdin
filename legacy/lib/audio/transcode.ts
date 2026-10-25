// SERVER ONLY — ffmpeg helpers for audio transcoding and segmentation.
//
// Gemini natively supports audio/webm, so transcoding is optional for short
// recordings. When ffmpeg IS available we transcode to MP3 (mono 16kHz 64kbps)
// to reduce upload size — Gemini downsamples internally anyway. For long
// recordings ffmpeg is required to split the file into per-request chunks.
//
// Two public entry points:
//   transcodeForGemini   — single-file transcode  (short recordings, optional)
//   transcodeAndChunk    — transcode + segment in ONE ffmpeg pass  (long recordings)
//
// Both paths decode the source exactly once; the caller cleans up output files.

import { spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PipelineError } from '@/lib/gemini/errors'
import { ffmpegBinary } from '@/lib/audio/binaries'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${cmd} exited with code ${code}. stderr: ${stderr.slice(-500)}`))
      }
    })
    proc.on('error', (err) => {
      reject(err)
    })
  })
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await runCommand(ffmpegBinary(), ['-version'])
    return true
  } catch {
    return false
  }
}

export async function requireFfmpeg(): Promise<void> {
  if (!(await isFfmpegAvailable())) {
    throw new PipelineError(
      'ffmpeg is required for audio transcoding but was not found in PATH. ' +
        'Install ffmpeg on the server: https://ffmpeg.org/download.html',
    )
  }
}

// ---------------------------------------------------------------------------
// Transcode functions
// ---------------------------------------------------------------------------

/**
 * Transcode `inputPath` to a Gemini-compatible mp3 (mono, 16kHz, 64kbps).
 * Output is written to `<outputDir>/audio.mp3`.
 *
 * Use this for short recordings (≤ 28 min) that fit in a single Gemini call.
 * For long recordings use transcodeAndChunk() to avoid decoding the source twice.
 *
 * @param inputPath  Source audio file (any format ffmpeg understands, e.g. .webm).
 * @param outputDir  Directory to write the mp3 into (created if absent).
 * @returns          Absolute path to the transcoded mp3.
 */
export async function transcodeForGemini(inputPath: string, outputDir: string): Promise<string> {
  await requireFfmpeg()
  await mkdir(outputDir, { recursive: true })
  const outputPath = join(outputDir, 'audio.mp3')
  await runCommand(ffmpegBinary(), [
    '-y', '-i', inputPath,
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    outputPath,
  ])
  return outputPath
}

/**
 * Transcode + segment `inputPath` in a single ffmpeg pass (no double-decode).
 * Produces mp3 chunks named `chunk_000.mp3`, `chunk_001.mp3`, … in `outputDir`.
 *
 * The caller is responsible for cleaning up `outputDir`.
 *
 * @param inputPath          Source audio file.
 * @param outputDir          Directory for chunk files (created if absent).
 * @param chunkDurationSecs  Duration per chunk in seconds.
 * @returns                  Sorted list of absolute paths to the mp3 chunks.
 */
export async function transcodeAndChunk(
  inputPath: string,
  outputDir: string,
  chunkDurationSecs: number,
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true })
  const pattern = join(outputDir, 'chunk_%03d.mp3')
  await runCommand(ffmpegBinary(), [
    '-y', '-i', inputPath,
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    '-f', 'segment',
    '-segment_time', String(chunkDurationSecs),
    '-reset_timestamps', '1',
    pattern,
  ])

  const files = await readdir(outputDir)
  const chunkFiles = files
    .filter((f) => /^chunk_\d+\.mp3$/.test(f))
    .sort()
    .map((f) => join(outputDir, f))

  if (chunkFiles.length === 0) {
    throw new PipelineError(
      'ffmpeg produced no output chunk files — check audio format compatibility',
    )
  }
  return chunkFiles
}

/**
 * Extract the audio track from a video file (or HTTPS URL) and write it as
 * an mp3 to `outputMp3Path`. The video stream is discarded; only audio is kept.
 *
 * When `inputPathOrUrl` is an HTTPS URL, ffmpeg fetches only the bytes it needs
 * rather than downloading the full file first.
 *
 * @param inputPathOrUrl  Local path or HTTPS URL to the source video.
 * @param outputMp3Path   Absolute path where the extracted mp3 will be written.
 */
export async function extractAudioFromVideo(
  inputPathOrUrl: string,
  outputMp3Path: string,
): Promise<void> {
  await requireFfmpeg()
  await runCommand(ffmpegBinary(), [
    '-y',
    '-i', inputPathOrUrl,
    '-vn',            // strip all video streams
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    outputMp3Path,
  ])
}
