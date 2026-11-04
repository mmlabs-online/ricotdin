import { describe, expect, it } from 'vitest'
import { UploadError, confirmMeetingUpload, parseDriveFileId, uploadAvatar, uploadErrorKey, uploadMeeting, type UploadDeps } from './upload'
import en from '../../i18n/locales/en.json'

const DRIVE = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc'

function deps(answers: Record<string, () => Response>, fileId = 'fileId_1234567890') {
  const calls: Array<{ path: string; body: unknown; method: string }> = []
  const puts: Array<{ url: string; type: string }> = []
  const d: UploadDeps = {
    fetchApi: async (path, init) => {
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
      const key = `${init?.method ?? 'GET'} ${path}`
      const answer = answers[key]
      if (!answer) throw new Error(`unexpected ${key}`)
      return answer()
    },
    putFile: async (url, _blob, type, onProgress) => {
      puts.push({ url, type })
      onProgress?.(1)
      return fileId
    },
  }
  return { d, calls, puts }
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })
const created = ok({ meetingId: 'm-1', uploadUrl: DRIVE, contentType: 'audio/mpeg' })
const blob = new Blob([new Uint8Array(10)], { type: 'audio/mpeg' })
const meta = { ext: '.mp3', mimeType: 'audio/mpeg', source: 'uploaded' as const, durationSeconds: 12, startedAt: '2026-11-04T09:00:00.000Z' }

describe('uploadMeeting', () => {
  it('creates the meeting, PUTs the file to Drive, then confirms it', async () => {
    const { d, calls, puts } = deps({ 'POST /meetings': created, 'POST /meetings/m-1/uploaded': ok({ ok: true }) })
    const progress: number[] = []
    expect(await uploadMeeting(d, blob, meta, (p) => progress.push(p))).toEqual({ meetingId: 'm-1' })
    expect(calls[0]?.body).toEqual({
      size: 10, fileExtension: '.mp3', mimeType: 'audio/mpeg', source: 'uploaded',
      durationSeconds: 12, startedAt: '2026-11-04T09:00:00.000Z',
    })
    expect(puts).toEqual([{ url: DRIVE, type: 'audio/mpeg' }])
    expect(calls[1]?.body).toEqual({ fileId: 'fileId_1234567890', size: 10 })
    expect(progress.at(-1)).toBe(1)
  })

  it('never PUTs the file anywhere but the Drive upload host', async () => {
    for (const uploadUrl of [
      'https://evil.example/upload',
      'http://www.googleapis.com/upload/drive/v3/files?upload_id=x',
      'https://www.googleapis.com/drive/v3/files',
      'https://www.googleapis.com/upload/storage/v1/b/x/o?upload_id=x', // not Drive: CSP allows only the Drive path
    ]) {
      const { d, puts } = deps({
        'POST /meetings': ok({ meetingId: 'm-1', uploadUrl, contentType: 'audio/mpeg' }),
        'DELETE /meetings/m-1': ok({}),
      })
      await expect(uploadMeeting(d, blob, meta)).rejects.toMatchObject({ step: 'create' })
      expect(puts).toHaveLength(0)
    }
  })

  it('maps API refusals to the failing step with the API code', async () => {
    const { d } = deps({ 'POST /meetings': () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), { status: 429 }) })
    const err = await uploadMeeting(d, blob, meta).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UploadError)
    expect(err).toMatchObject({ step: 'create', code: 'rate_limited', status: 429 })
  })

  it('deletes the pending meeting when the Drive upload fails (frees the pending slot)', async () => {
    const { d, calls } = deps({ 'POST /meetings': created, 'DELETE /meetings/m-1': ok({}) })
    d.putFile = async () => {
      throw new UploadError('upload', 'network', 0)
    }
    await expect(uploadMeeting(d, blob, meta)).rejects.toMatchObject({ step: 'upload' })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /meetings', 'DELETE /meetings/m-1'])
  })

  it('a confirm failure keeps the meeting and carries what a confirm-only retry needs', async () => {
    const { d } = deps({ 'POST /meetings': created, 'POST /meetings/m-1/uploaded': () => new Response('', { status: 502 }) })
    const err = (await uploadMeeting(d, blob, meta).catch((e: unknown) => e)) as UploadError
    expect(err).toMatchObject({ step: 'confirm', status: 502, resume: { meetingId: 'm-1', fileId: 'fileId_1234567890', size: 10 } })
    const again = deps({ 'POST /meetings/m-1/uploaded': ok({ ok: true }) })
    expect(await confirmMeetingUpload(again.d, err.resume!)).toEqual({ meetingId: 'm-1' })
    expect(again.calls.map((c) => c.path)).toEqual(['/meetings/m-1/uploaded'])
  })

  it('a retried confirm answered 409 means the first one went through (lost response)', async () => {
    const pending = { meetingId: 'm-1', fileId: 'fileId_1234567890', size: 10 }
    const { d } = deps({ 'POST /meetings/m-1/uploaded': () => new Response('{}', { status: 409 }) })
    expect(await confirmMeetingUpload(d, pending, { retry: true })).toEqual({ meetingId: 'm-1' })
    await expect(confirmMeetingUpload(d, pending)).rejects.toMatchObject({ status: 409 })
  })

  it('a confirm failure keeps the meeting (the API decides) and reports it', async () => {
    const { d } = deps({
      'POST /meetings': created,
      'POST /meetings/m-1/uploaded': () => new Response(JSON.stringify({ error: { code: 'unprocessable', message: '' } }), { status: 422 }),
    })
    await expect(uploadMeeting(d, blob, meta)).rejects.toMatchObject({ step: 'confirm', status: 422 })
  })
})

describe('parseDriveFileId', () => {
  it('reads the id Drive returns for the finished upload', () => {
    expect(parseDriveFileId('{"id":"1AbC_def-GHIjk"}')).toBe('1AbC_def-GHIjk')
  })
  it('refuses anything else', () => {
    for (const body of ['', 'nope', '{}', '{"id":"short"}', '{"id":"bad/../id1234"}', '{"id":5}']) {
      expect(parseDriveFileId(body), body).toBeNull()
    }
  })
})

describe('uploadAvatar (PRF-04)', () => {
  const png = new Blob([new Uint8Array(100)], { type: 'image/png' })
  it('asks for an upload URL, PUTs to Drive, then saves the key with the file', async () => {
    const { d, calls, puts } = deps({
      'POST /profile/avatar': ok({ uploadUrl: DRIVE, avatarKey: 'avatars/u/1.png' }),
      'PATCH /profile': ok({}),
    })
    await uploadAvatar(d, png)
    expect(calls[0]?.body).toEqual({ contentType: 'image/png', size: 100 })
    expect(puts).toEqual([{ url: DRIVE, type: 'image/png' }])
    expect(calls[1]?.body).toEqual({ avatar_key: 'avatars/u/1.png', avatar_file_id: 'fileId_1234567890', avatar_size: 100 })
  })
  it('refuses other image types and files over 2 MB before any request', async () => {
    const { d, calls } = deps({})
    await expect(uploadAvatar(d, new Blob(['x'], { type: 'image/gif' }))).rejects.toMatchObject({ code: 'type' })
    await expect(uploadAvatar(d, new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }))).rejects.toMatchObject({ code: 'size' })
    expect(calls).toHaveLength(0)
  })
})

describe('uploadErrorKey', () => {
  it('maps every failure to an existing message, never server text', () => {
    const cases: Array<[unknown, string]> = [
      [new UploadError('create', 'network', 0), 'upload.errors.network'],
      [new UploadError('upload', 'aborted', 0), 'upload.errors.aborted'],
      [new UploadError('create', 'rate_limited', 429), 'upload.errors.tooMany'],
      [new UploadError('create', 'unprocessable', 422), 'upload.errors.rejected'],
      [new UploadError('create', 'service_unavailable', 503), 'upload.errors.unavailable'],
      [new UploadError('upload', 'drive_403', 403), 'upload.errors.drive'],
      [new UploadError('confirm', 'unprocessable', 422), 'upload.errors.confirm'],
      [new UploadError('create', 'type', 0), 'upload.errors.avatarType'],
      [new UploadError('create', 'size', 0), 'upload.errors.avatarSize'],
      [new Error('x'), 'upload.errors.generic'],
    ]
    for (const [err, key] of cases) {
      expect(uploadErrorKey(err)).toBe(key)
      const leaf = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en)
      expect(typeof leaf, key).toBe('string')
    }
  })
})
