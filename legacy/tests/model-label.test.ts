// Unit tests for formatModelLabel (meeting model badge).
// All pure — no I/O.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatModelLabel } from '../lib/ai/modelLabel.js'

describe('formatModelLabel', () => {
  it('maps gemini-2.5-flash to a friendly label', () => {
    assert.equal(formatModelLabel('gemini', 'gemini-2.5-flash'), 'Gemini 2.5 Flash')
  })

  it('maps gemini-2.5-flash-lite', () => {
    assert.equal(formatModelLabel('gemini', 'gemini-2.5-flash-lite'), 'Gemini 2.5 Flash-Lite')
  })

  it('maps openai gpt-4o and gpt-4o-mini', () => {
    assert.equal(formatModelLabel('openai', 'gpt-4o'), 'GPT-4o')
    assert.equal(formatModelLabel('openai', 'gpt-4o-mini'), 'GPT-4o mini')
  })

  it('maps grok models', () => {
    assert.equal(formatModelLabel('grok', 'grok-4'), 'Grok 4')
    assert.equal(formatModelLabel('grok', 'grok-3-mini'), 'Grok 3 mini')
  })

  it('falls back to "<provider> <model>" for unknown pairs', () => {
    assert.equal(formatModelLabel('grok', 'grok-5-ultra'), 'grok grok-5-ultra')
    assert.equal(formatModelLabel('anthropic', 'claude-opus'), 'anthropic claude-opus')
  })

  it('does not throw on empty strings', () => {
    assert.equal(formatModelLabel('', ''), ' ')
  })
})
