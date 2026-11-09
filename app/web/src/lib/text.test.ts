import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { displayText, isInvisibleCharactersError } from './text'

describe('displayText (user text from other people)', () => {
  it('removes bidi controls and zero-width characters that can reorder or hide the UI text', () => {
    expect(displayText('evil‮gnp.exe')).toBe('evilgnp.exe')
    expect(displayText('a⁦b⁩c​d‏e﻿')).toBe('abcde')
  })
  it('keeps normal text, including Vietnamese', () => {
    expect(displayText('Đồng bộ khách hàng')).toBe('Đồng bộ khách hàng')
  })
})

describe('isInvisibleCharactersError (SEC-05)', () => {
  it('recognises the API refusal of names with invisible characters, by code only', () => {
    expect(isInvisibleCharactersError(new ApiError(400, 'invalid_characters', 'x'))).toBe(true)
    expect(isInvisibleCharactersError(new ApiError(422, 'invalid_characters', 'x'))).toBe(true)
    expect(isInvisibleCharactersError(new ApiError(400, 'bad_request', 'invalid_characters'))).toBe(false)
    expect(isInvisibleCharactersError(new Error('invalid_characters'))).toBe(false)
  })
})
