// Unit tests for lib/audio/transcode.ts.
//
// The ffmpeg-dependent test is skipped gracefully if ffmpeg is not installed in
// the test environment — it generates a 1-second silent webm fixture via ffmpeg
// itself, then verifies transcodeForGemini produces a non-empty mp3.
//
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, rm } from 'node:fs/promises'
import { isFfmpegAvailable, transcodeForGemini } from '../lib/audio/transcode.js'
import { ffmpegBinary } from '../lib/audio/binaries.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe' })
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    )
    proc.on('error', reject)
  })
}

/** Generate a 1-second silent webm file using ffmpeg (requires ffmpeg to be present). */
async function generateSilentWebm(outputPath: string): Promise<void> {
  await spawnAsync(ffmpegBinary(), [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=16000:cl=mono',
    '-t', '1',
    '-c:a', 'libopus',
    outputPath,
  ])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isFfmpegAvailable', () => {
  it('returns a boolean without throwing', async () => {
    const result = await isFfmpegAvailable()
    assert.equal(typeof result, 'boolean')
  })
})

describe('transcodeForGemini', () => {
  it('produces a non-empty mp3 from a webm source when ffmpeg is available', async (t) => {
    const ffmpegPresent = await isFfmpegAvailable()
    if (!ffmpegPresent) {
      t.skip('ffmpeg not found in PATH — skipping transcode test')
      return
    }

    const testDir = join(tmpdir(), `transcode-test-${randomUUID()}`)
    await mkdir(testDir, { recursive: true })
    const inputPath = join(testDir, 'input.webm')

    try {
      await generateSilentWebm(inputPath)

      const outputDir = join(testDir, 'out')
      const mp3Path = await transcodeForGemini(inputPath, outputDir)

      assert.ok(mp3Path.endsWith('.mp3'), 'output path should end with .mp3')
      const info = await stat(mp3Path)
      assert.ok(info.size > 0, 'mp3 file should be non-empty')
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('throws a PipelineError mentioning ffmpeg when ffmpeg is not available', async (t) => {
    const ffmpegPresent = await isFfmpegAvailable()
    if (ffmpegPresent) {
      // Can only test the missing-ffmpeg path in environments without ffmpeg.
      // The positive path is covered by the previous test.
      t.skip('ffmpeg is available — missing-ffmpeg error path not testable here')
      return
    }

    const { PipelineError } = await import('../lib/gemini/errors.js')
    await assert.rejects(
      () => transcodeForGemini('/any/path.webm', '/any/out'),
      (err: unknown) => {
        assert.ok(err instanceof PipelineError, 'should throw a PipelineError')
        assert.ok(
          (err as Error).message.toLowerCase().includes('ffmpeg'),
          `error message should mention ffmpeg; got: ${(err as Error).message}`,
        )
        return true
      },
    )
  })
})
