// Unit tests for lib/audio/ffprobe.ts — pure parseProbeResult only.
// No filesystem or process I/O. Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseProbeResult } from '../lib/audio/ffprobe.js'

// ---------------------------------------------------------------------------
// Fixtures — typical ffprobe -print_format json -show_streams output shapes
// ---------------------------------------------------------------------------

const AUDIO_ONLY_MP3 = {
  streams: [
    { index: 0, codec_name: 'mp3', codec_type: 'audio', sample_rate: '44100', channels: 2 },
  ],
}

const AUDIO_ONLY_WAV = {
  streams: [
    { index: 0, codec_name: 'pcm_s16le', codec_type: 'audio', sample_rate: '16000', channels: 1 },
  ],
}

const AUDIO_ONLY_WEBM = {
  streams: [
    { index: 0, codec_name: 'opus', codec_type: 'audio', sample_rate: '48000', channels: 2 },
  ],
}

const AUDIO_ONLY_AAC = {
  streams: [
    { index: 0, codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 2 },
  ],
}

const VIDEO_WITH_AUDIO = {
  streams: [
    { index: 0, codec_name: 'h264', codec_type: 'video' },
    { index: 1, codec_name: 'aac', codec_type: 'audio' },
  ],
}

const VIDEO_ONLY = {
  streams: [
    { index: 0, codec_name: 'h264', codec_type: 'video' },
  ],
}

const MULTI_AUDIO = {
  streams: [
    { index: 0, codec_name: 'mp3', codec_type: 'audio', channels: 1 },
    { index: 1, codec_name: 'opus', codec_type: 'audio', channels: 2 },
  ],
}

const EMPTY_STREAMS = { streams: [] }

// ---------------------------------------------------------------------------
// Valid audio-only files
// ---------------------------------------------------------------------------

describe('parseProbeResult — valid audio-only files', () => {
  it('accepts mp3', () => {
    const result = parseProbeResult(AUDIO_ONLY_MP3)
    assert.ok(result.valid)
    assert.equal(result.reason, undefined)
  })

  it('accepts wav', () => {
    const result = parseProbeResult(AUDIO_ONLY_WAV)
    assert.ok(result.valid)
  })

  it('accepts webm with opus audio', () => {
    const result = parseProbeResult(AUDIO_ONLY_WEBM)
    assert.ok(result.valid)
  })

  it('accepts aac', () => {
    const result = parseProbeResult(AUDIO_ONLY_AAC)
    assert.ok(result.valid)
  })

  it('accepts multiple audio streams (no video)', () => {
    const result = parseProbeResult(MULTI_AUDIO)
    assert.ok(result.valid)
  })
})

// ---------------------------------------------------------------------------
// Rejected files
// ---------------------------------------------------------------------------

describe('parseProbeResult — rejected files', () => {
  it('rejects a file that has a video stream', () => {
    const result = parseProbeResult(VIDEO_WITH_AUDIO)
    assert.ok(!result.valid)
    assert.ok(result.reason?.toLowerCase().includes('video'))
  })

  it('rejects a video-only file', () => {
    const result = parseProbeResult(VIDEO_ONLY)
    assert.ok(!result.valid)
    assert.ok(result.reason?.toLowerCase().includes('video'))
  })

  it('rejects a file with no streams at all', () => {
    const result = parseProbeResult(EMPTY_STREAMS)
    assert.ok(!result.valid)
    assert.ok(result.reason?.toLowerCase().includes('audio'))
  })

  it('rejects when streams array is missing', () => {
    const result = parseProbeResult({})
    assert.ok(!result.valid)
  })
})

// ---------------------------------------------------------------------------
// Defensive / garbage input
// ---------------------------------------------------------------------------

describe('parseProbeResult — garbage input', () => {
  it('returns invalid for null input', () => {
    const result = parseProbeResult(null)
    assert.ok(!result.valid)
  })

  it('returns invalid for string input', () => {
    const result = parseProbeResult('not json')
    assert.ok(!result.valid)
  })

  it('returns invalid for number input', () => {
    const result = parseProbeResult(42)
    assert.ok(!result.valid)
  })

  it('returns invalid when streams is not an array', () => {
    const result = parseProbeResult({ streams: 'not-an-array' })
    assert.ok(!result.valid)
  })

  it('skips stream entries that lack codec_type', () => {
    // A probe output with one unknown stream — should be invalid (no audio)
    const result = parseProbeResult({ streams: [{ index: 0, codec_name: 'unknown' }] })
    assert.ok(!result.valid)
  })

  it('treats data streams (attachments, subtitles) as non-blocking', () => {
    // Some files have attachment/subtitle streams alongside audio
    const input = {
      streams: [
        { codec_type: 'audio', codec_name: 'mp3' },
        { codec_type: 'data', codec_name: 'bin_data' },
        { codec_type: 'attachment', codec_name: 'none' },
      ],
    }
    const result = parseProbeResult(input)
    assert.ok(result.valid, `expected valid but got: ${result.reason}`)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseProbeResult — edge cases', () => {
  it('is case-insensitive on codec_type', () => {
    const result = parseProbeResult({
      streams: [{ codec_type: 'Audio', codec_name: 'mp3' }],
    })
    // Our implementation normalises to lowercase, so this should pass
    assert.ok(result.valid)
  })

  it('rejects when video stream has codec_type in uppercase', () => {
    const result = parseProbeResult({
      streams: [
        { codec_type: 'Audio', codec_name: 'aac' },
        { codec_type: 'Video', codec_name: 'h264' },
      ],
    })
    assert.ok(!result.valid)
  })
})

// ---------------------------------------------------------------------------
// Video mode ('video' probe mode)
// ---------------------------------------------------------------------------

describe("parseProbeResult — mode='video'", () => {
  it('accepts video+audio file (normal mp4)', () => {
    const result = parseProbeResult(VIDEO_WITH_AUDIO, 'video')
    assert.ok(result.valid, `expected valid but got: ${result.reason}`)
  })

  it('accepts audio-only file in video mode (audio can still be extracted)', () => {
    const result = parseProbeResult(AUDIO_ONLY_MP3, 'video')
    assert.ok(result.valid)
  })

  it('accepts webm with video and audio in video mode', () => {
    const mixed = {
      streams: [
        { codec_name: 'vp9', codec_type: 'video' },
        { codec_name: 'opus', codec_type: 'audio' },
      ],
    }
    const result = parseProbeResult(mixed, 'video')
    assert.ok(result.valid)
  })

  it('rejects a video-only file (no audio track to extract)', () => {
    const result = parseProbeResult(VIDEO_ONLY, 'video')
    assert.ok(!result.valid)
    assert.ok(result.reason?.toLowerCase().includes('audio'))
  })

  it('rejects empty streams in video mode', () => {
    const result = parseProbeResult(EMPTY_STREAMS, 'video')
    assert.ok(!result.valid)
  })

  it('rejects null input in video mode', () => {
    const result = parseProbeResult(null, 'video')
    assert.ok(!result.valid)
  })

  it('is case-insensitive on codec_type in video mode', () => {
    const result = parseProbeResult({
      streams: [
        { codec_type: 'Video', codec_name: 'h264' },
        { codec_type: 'Audio', codec_name: 'aac' },
      ],
    }, 'video')
    assert.ok(result.valid)
  })
})
