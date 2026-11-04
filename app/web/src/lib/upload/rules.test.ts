import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, checkUploadFile, fileExtension, formatBytes, recordingExtension } from './rules'

const MB = 1024 * 1024

describe('checkUploadFile', () => {
  it('accepts audio and video within the 500 MB cap (owner decision 2026-11-04)', () => {
    expect(MAX_UPLOAD_BYTES).toBe(500 * MB)
    expect(MAX_UPLOAD_LABEL).toBe('500 MB')
    expect(checkUploadFile('Weekly Sync.MP3', 10 * MB, 'audio/mpeg')).toEqual({
      ok: true, ext: '.mp3', source: 'uploaded', mimeType: 'audio/mpeg',
    })
    expect(checkUploadFile('demo.mov', MB, '')).toEqual({ ok: true, ext: '.mov', source: 'video', mimeType: 'video/quicktime' })
  })
  it('uses the extension type when the browser reports another one', () => {
    expect(checkUploadFile('a.m4a', MB, 'application/octet-stream')).toMatchObject({ ok: true, mimeType: 'audio/mp4' })
    expect(checkUploadFile('a.webm', MB, 'audio/webm;codecs=opus')).toMatchObject({ ok: true, mimeType: 'audio/webm;codecs=opus' })
  })
  it('rejects other types before any upload', () => {
    expect(checkUploadFile('notes.pdf', MB, 'application/pdf')).toEqual({ ok: false, error: 'type', ext: '.pdf' })
    expect(checkUploadFile('noext', MB, '')).toEqual({ ok: false, error: 'type', ext: '' })
  })
  it('rejects files over the cap and empty files', () => {
    expect(checkUploadFile('big.wav', MAX_UPLOAD_BYTES + 1, 'audio/wav')).toEqual({ ok: false, error: 'size', ext: '.wav' })
    expect(checkUploadFile('ok.wav', MAX_UPLOAD_BYTES, 'audio/wav').ok).toBe(true)
    expect(checkUploadFile('empty.wav', 0, 'audio/wav')).toEqual({ ok: false, error: 'empty', ext: '.wav' })
  })
})

describe('helpers', () => {
  it('fileExtension', () => {
    expect(fileExtension('a.b.FLAC')).toBe('.flac')
    expect(fileExtension('.hidden')).toBe('.hidden')
    expect(fileExtension('none')).toBe('')
  })
  it('recordingExtension follows the recorder type', () => {
    expect(recordingExtension('audio/webm;codecs=opus')).toBe('.webm')
    expect(recordingExtension('audio/ogg;codecs=opus')).toBe('.ogg')
    expect(recordingExtension('audio/mp4')).toBe('.m4a')
    expect(recordingExtension('')).toBe('.webm')
  })
  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('0.5 KB')
    expect(formatBytes(5 * MB)).toBe('5.0 MB')
    expect(formatBytes(500 * MB)).toBe('500.0 MB')
  })
})
