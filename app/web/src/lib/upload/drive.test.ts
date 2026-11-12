import { describe, expect, it } from 'vitest'
import { sessionStatusRequest, finishedFileId } from './upload'

describe('Drive session status (did a failed PUT actually finish?)', () => {
  it('asks with an empty PUT and Content-Range bytes */size', () => {
    expect(sessionStatusRequest(1234)).toEqual({ method: 'PUT', headers: { 'Content-Range': 'bytes */1234' } })
  })
  it('a 200/201 with the file resource means done; 308 or anything else means not done', () => {
    expect(finishedFileId(200, '{"id":"fileId_1234567890"}')).toBe('fileId_1234567890')
    expect(finishedFileId(201, '{"id":"fileId_1234567890"}')).toBe('fileId_1234567890')
    expect(finishedFileId(308, '')).toBeNull()
    expect(finishedFileId(404, '{"id":"fileId_1234567890"}')).toBeNull()
    expect(finishedFileId(200, 'oops')).toBeNull()
  })
})
