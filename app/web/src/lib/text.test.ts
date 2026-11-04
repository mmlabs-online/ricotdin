import { describe, expect, it } from 'vitest'
import { displayText } from './text'

describe('displayText (user text from other people)', () => {
  it('removes bidi controls and zero-width characters that can reorder or hide the UI text', () => {
    expect(displayText('evil‮gnp.exe')).toBe('evilgnp.exe')
    expect(displayText('a⁦b⁩c​d‏e﻿')).toBe('abcde')
  })
  it('keeps normal text, including Vietnamese', () => {
    expect(displayText('Đồng bộ khách hàng')).toBe('Đồng bộ khách hàng')
  })
})
