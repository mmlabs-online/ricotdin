// Unit tests for GeminiAdapter (AIP-01).
// All hermetic — pool is injected as a mock; no live Gemini keys or DB calls.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiAdapter } from '../lib/ai/adapters/gemini.js'
import type { GeminiPool, GeminiClient } from '../lib/ai/adapters/gemini.js'

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

interface MockResponse {
  text: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

interface MockPool extends GeminiPool {
  /** Number of times pool.call() was invoked (= number of distinct key acquisitions). */
  poolCallCount: number
  /** Ordered list of generateContent call options. */
  calls: unknown[]
}

function makeMockPool(responses: MockResponse[]): MockPool {
  let responseIndex = 0
  const calls: unknown[] = []
  let poolCallCount = 0

  const pool: MockPool = {
    poolCallCount: 0,
    calls,
    call: async <T>(fn: (ai: GeminiClient, keyId: string | null) => Promise<T>): Promise<T> => {
      poolCallCount++
      pool.poolCallCount = poolCallCount

      const mockAi: GeminiClient = {
        models: {
          generateContent: async (opts) => {
            calls.push(opts)
            const resp = responses[responseIndex] ?? responses[responses.length - 1]
            responseIndex++
            return { text: resp.text, usageMetadata: resp.usageMetadata }
          },
        },
      }

      return fn(mockAi, 'mock-key-id')
    },
  }

  return pool
}

// ---------------------------------------------------------------------------
// generateStructured — success path
// ---------------------------------------------------------------------------

describe('GeminiAdapter.generateStructured — success', () => {
  it('returns parsed data on first attempt', async () => {
    const pool = makeMockPool([{
      text: '{"answer":"hello"}',
      usageMetadata: { totalTokenCount: 10, promptTokenCount: 7, candidatesTokenCount: 3 },
    }])
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'question',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: (text) => JSON.parse(text) as { answer: string },
      operation: 'test',
    })

    assert.deepEqual(result.data, { answer: 'hello' })
    assert.equal(result.rawText, '{"answer":"hello"}')
    assert.equal(result.totalTokens,  10)
    assert.equal(result.inputTokens,   7)
    assert.equal(result.outputTokens,  3)
    assert.equal(result.keyId, 'mock-key-id')
  })

  it('makes exactly one generateContent call on success', async () => {
    const pool = makeMockPool([{ text: '42' }])
    const adapter = new GeminiAdapter(pool)

    await adapter.generateStructured({
      messages: 'q',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: (text) => Number(text),
      operation: 'test',
    })

    assert.equal(pool.calls.length, 1)
  })

  it('passes systemInstruction and schema through to generateContent', async () => {
    const pool = makeMockPool([{ text: '{}' }])
    const adapter = new GeminiAdapter(pool)
    const schema = { type: 'object' }

    await adapter.generateStructured({
      messages: 'prompt',
      schema,
      model: 'gemini-2.5-flash',
      systemInstruction: 'You are a test bot.',
      parse: JSON.parse as (s: string) => unknown,
      operation: 'test',
    })

    const opts = pool.calls[0] as { config?: { systemInstruction?: string; responseSchema?: unknown } }
    assert.equal(opts.config?.systemInstruction, 'You are a test bot.')
    assert.deepEqual(opts.config?.responseSchema, schema)
  })
})

// ---------------------------------------------------------------------------
// generateStructured — parse-fail retry (same key invariant)
// ---------------------------------------------------------------------------

describe('GeminiAdapter.generateStructured — parse-fail retry', () => {
  it('retries with retryMessages when parse throws', async () => {
    const pool = makeMockPool([
      { text: 'INVALID JSON' },
      { text: '{"answer":"retried"}', usageMetadata: { totalTokenCount: 15 } },
    ])
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'first-prompt',
      retryMessages: 'strict-prompt',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: (text) => JSON.parse(text) as { answer: string },
      operation: 'test',
    })

    assert.deepEqual(result.data, { answer: 'retried' })
    assert.equal(result.totalTokens, 15)
  })

  it('uses the SAME pool.call() for both attempts (same key)', async () => {
    const pool = makeMockPool([
      { text: 'BAD' },
      { text: '{"x":1}' },
    ])
    const adapter = new GeminiAdapter(pool)

    await adapter.generateStructured({
      messages: 'first',
      retryMessages: 'retry',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: (text) => JSON.parse(text) as unknown,
      operation: 'test',
    })

    assert.equal(pool.calls.length, 2,       'two generateContent calls')
    assert.equal(pool.poolCallCount, 1,       'one pool.call() — same key for both')
  })

  it('sends retryMessages (not original messages) on the second call', async () => {
    const pool = makeMockPool([
      { text: 'BAD' },
      { text: '{"x":1}' },
    ])
    const adapter = new GeminiAdapter(pool)

    await adapter.generateStructured({
      messages: 'ORIGINAL',
      retryMessages: 'STRICT',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: (text) => JSON.parse(text) as unknown,
      operation: 'test',
    })

    const firstCall  = pool.calls[0] as { contents: string }
    const secondCall = pool.calls[1] as { contents: string }
    assert.equal(firstCall.contents,  'ORIGINAL')
    assert.equal(secondCall.contents, 'STRICT')
  })

  it('throws when parse fails and no retryMessages provided', async () => {
    const pool = makeMockPool([{ text: 'INVALID JSON' }])
    const adapter = new GeminiAdapter(pool)

    await assert.rejects(
      () => adapter.generateStructured({
        messages: 'prompt',
        schema: {},
        model: 'gemini-2.5-flash',
        parse: (text) => JSON.parse(text) as unknown,
        operation: 'test',
      }),
      /SyntaxError/,
    )
  })

  it('throws when both attempts fail', async () => {
    const pool = makeMockPool([{ text: 'BAD1' }, { text: 'BAD2' }])
    const adapter = new GeminiAdapter(pool)

    await assert.rejects(() =>
      adapter.generateStructured({
        messages: 'first',
        retryMessages: 'retry',
        schema: {},
        model: 'gemini-2.5-flash',
        parse: (text) => JSON.parse(text) as unknown,
        operation: 'test',
      }),
    )

    assert.equal(pool.calls.length, 2, 'both attempts were made before throwing')
  })
})

// ---------------------------------------------------------------------------
// generateStructured — output contract
// ---------------------------------------------------------------------------

describe('GeminiAdapter.generateStructured — output contract', () => {
  it('rawText reflects the actual response text (first attempt)', async () => {
    const pool = makeMockPool([{ text: '{"key":"value"}' }])
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: JSON.parse as (s: string) => unknown,
      operation: 'test',
    })

    assert.equal(result.rawText, '{"key":"value"}')
  })

  it('rawText reflects the retry response text when retry succeeds', async () => {
    const pool = makeMockPool([
      { text: 'BAD' },
      { text: '{"retry":true}' },
    ])
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q',
      retryMessages: 'strict',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: JSON.parse as (s: string) => unknown,
      operation: 'test',
    })

    assert.equal(result.rawText, '{"retry":true}')
  })

  it('keyId is null when pool passes null', async () => {
    let poolCallCount = 0
    const pool: GeminiPool = {
      call: async (fn) => {
        poolCallCount++
        return fn({ models: { generateContent: async () => ({ text: '1' }) } }, null)
      },
    }
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q',
      schema: {},
      model: 'gemini-2.5-flash',
      parse: (t) => Number(t),
      operation: 'test',
    })

    assert.equal(result.keyId, null)
    assert.equal(poolCallCount, 1)
  })
})

// ---------------------------------------------------------------------------
// generateText
// ---------------------------------------------------------------------------

describe('GeminiAdapter.generateText', () => {
  it('returns text and usage on success', async () => {
    const pool = makeMockPool([{
      text: 'hello world',
      usageMetadata: { totalTokenCount: 5, promptTokenCount: 3, candidatesTokenCount: 2 },
    }])
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateText({
      messages: 'ping',
      model: 'gemini-2.5-flash',
    })

    assert.equal(result.text, 'hello world')
    assert.equal(result.totalTokens,  5)
    assert.equal(result.inputTokens,  3)
    assert.equal(result.outputTokens, 2)
    assert.equal(result.keyId, 'mock-key-id')
  })

  it('returns empty string when response text is undefined', async () => {
    const pool: GeminiPool = {
      call: async (fn) => fn({ models: { generateContent: async () => ({}) } }, 'k'),
    }
    const adapter = new GeminiAdapter(pool)

    const result = await adapter.generateText({ messages: 'q', model: 'gemini-2.5-flash' })
    assert.equal(result.text, '')
  })
})
