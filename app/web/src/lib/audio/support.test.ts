import { describe, expect, it } from 'vitest'
import { recorderErrorKey } from './support'

describe('recorderErrorKey', () => {
  it('maps capture errors to i18n keys (never the browser text)', () => {
    const e = (name: string) => Object.assign(new Error('x'), { name })
    expect(recorderErrorKey(e('NotAllowedError'))).toBe('record.errors.denied')
    expect(recorderErrorKey(e('NotFoundError'))).toBe('record.errors.noMic')
    expect(recorderErrorKey(e('AbortError'))).toBe('record.errors.cancelled')
    expect(recorderErrorKey(e('InvalidStateError'))).toBe('record.errors.state')
    expect(recorderErrorKey(e('Other'))).toBe('record.errors.generic')
    expect(recorderErrorKey('boom')).toBe('record.errors.generic')
  })
})
