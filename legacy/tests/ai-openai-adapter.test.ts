// Unit tests for OpenAIAdapter (AIP-02).
// All hermetic — pool and client are injected as mocks; no live OpenAI calls.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OpenAIAdapter,
  RefusalError,
  toOpenAIStrictSchema,
} from '../lib/ai/adapters/openai.js'
import type {
  OpenAIPool,
  OpenAIClient,
  OpenAIChatCompletion,
  OpenAICreateParams,
} from '../lib/ai/adapters/openai.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface CapturedCall {
  params: OpenAICreateParams
}

function makeMockClient(
  responses: Array<Partial<OpenAIChatCompletion>>,
  captured: CapturedCall[] = [],
): OpenAIClient {
  let idx = 0
  return {
    chat: {
      completions: {
        create: async (params) => {
          captured.push({ params })
          const base = responses[idx] ?? responses[responses.length - 1]
          idx++
          return {
            choices: [{ message: { content: '{}', refusal: null } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            ...base,
          }
        },
      },
    },
  }
}

function makeMockPool(client: OpenAIClient, keyId: string | null = 'mock-key-id'): {
  pool: OpenAIPool
  poolCallCount: number
} {
  let poolCallCount = 0
  const state = { poolCallCount }
  const pool: OpenAIPool = {
    call: async (fn) => {
      poolCallCount++
      state.poolCallCount = poolCallCount
      return fn(client, keyId)
    },
  }
  return { pool, poolCallCount: state.poolCallCount }
}

// Convenience: pool + client in one call; returns pool and captured calls array.
function makePool(
  responses: Array<Partial<OpenAIChatCompletion>>,
  keyId: string | null = 'key-1',
): { pool: OpenAIPool; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const client = makeMockClient(responses, calls)
  const { pool } = makeMockPool(client, keyId)
  return { pool, calls }
}

// ---------------------------------------------------------------------------
// toOpenAIStrictSchema — schema translation
// ---------------------------------------------------------------------------

describe('toOpenAIStrictSchema — primitive types', () => {
  it('translates Gemini uppercase STRING to lowercase string', () => {
    const result = toOpenAIStrictSchema({ type: 'STRING' })
    assert.deepEqual(result, { type: 'string' })
  })

  it('translates INTEGER', () => {
    assert.deepEqual(toOpenAIStrictSchema({ type: 'INTEGER' }), { type: 'integer' })
  })

  it('passes through already-lowercase types unchanged', () => {
    assert.deepEqual(toOpenAIStrictSchema({ type: 'string' }), { type: 'string' })
  })

  it('preserves description on primitive field', () => {
    const result = toOpenAIStrictSchema({ type: 'STRING', description: 'A name' })
    assert.equal(result.description, 'A name')
    assert.equal(result.type, 'string')
  })
})

describe('toOpenAIStrictSchema — nullable fields', () => {
  it('nullable string → anyOf union', () => {
    const result = toOpenAIStrictSchema({ type: 'STRING', nullable: true })
    assert.deepEqual(result.anyOf, [{ type: 'string' }, { type: 'null' }])
    assert.equal(result.type, undefined)
  })

  it('nullable integer → anyOf union', () => {
    const result = toOpenAIStrictSchema({ type: 'INTEGER', nullable: true })
    assert.deepEqual(result.anyOf, [{ type: 'integer' }, { type: 'null' }])
  })

  it('preserves description alongside anyOf', () => {
    const result = toOpenAIStrictSchema({ type: 'STRING', nullable: true, description: 'opt' })
    assert.equal(result.description, 'opt')
    assert.ok(Array.isArray(result.anyOf))
  })

  it('non-nullable field does NOT produce anyOf', () => {
    const result = toOpenAIStrictSchema({ type: 'STRING', nullable: false })
    assert.equal(result.anyOf, undefined)
    assert.equal(result.type, 'string')
  })
})

describe('toOpenAIStrictSchema — object nodes', () => {
  it('adds additionalProperties: false to object', () => {
    const result = toOpenAIStrictSchema({
      type: 'OBJECT',
      properties: { name: { type: 'STRING' } },
    })
    assert.equal(result.additionalProperties, false)
  })

  it('uses existing required array when present', () => {
    const result = toOpenAIStrictSchema({
      type: 'OBJECT',
      properties: { a: { type: 'STRING' }, b: { type: 'STRING' } },
      required: ['a', 'b'],
    })
    assert.deepEqual(result.required, ['a', 'b'])
  })

  it('derives required from properties keys when absent', () => {
    const result = toOpenAIStrictSchema({
      type: 'OBJECT',
      properties: { x: { type: 'STRING' }, y: { type: 'INTEGER' } },
    })
    assert.ok(Array.isArray(result.required))
    assert.ok((result.required as string[]).includes('x'))
    assert.ok((result.required as string[]).includes('y'))
  })

  it('recursively translates nested properties', () => {
    const result = toOpenAIStrictSchema({
      type: 'OBJECT',
      properties: {
        assignee: { type: 'STRING', nullable: true },
        count:    { type: 'INTEGER' },
      },
      required: ['assignee', 'count'],
    })
    const props = result.properties as Record<string, unknown>
    assert.deepEqual((props['assignee'] as Record<string, unknown>).anyOf, [
      { type: 'string' }, { type: 'null' },
    ])
    assert.equal((props['count'] as Record<string, unknown>).type, 'integer')
  })
})

describe('toOpenAIStrictSchema — array nodes', () => {
  it('translates items recursively', () => {
    const result = toOpenAIStrictSchema({
      type: 'ARRAY',
      items: { type: 'STRING' },
    })
    assert.equal(result.type, 'array')
    assert.deepEqual(result.items, { type: 'string' })
  })

  it('translates array of objects', () => {
    const result = toOpenAIStrictSchema({
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' } },
        required: ['id'],
      },
    })
    const items = result.items as Record<string, unknown>
    assert.equal(items.type, 'object')
    assert.equal(items.additionalProperties, false)
  })
})

describe('toOpenAIStrictSchema — full analysis schema spot-check', () => {
  // Mirrors the ANALYSIS_RESPONSE_SCHEMA shape used by analyzeTranscript().
  const geminiSchema = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      notes_markdown: { type: 'STRING' },
      todos: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            content: { type: 'STRING' },
            assignee: { type: 'STRING', nullable: true },
            due_date: { type: 'STRING', nullable: true },
            source_segment_index: { type: 'INTEGER', nullable: true },
          },
          required: ['content', 'assignee', 'due_date', 'source_segment_index'],
        },
      },
    },
    required: ['summary', 'notes_markdown', 'todos'],
  }

  it('top-level object has additionalProperties: false', () => {
    const result = toOpenAIStrictSchema(geminiSchema)
    assert.equal(result.additionalProperties, false)
  })

  it('todo item object has additionalProperties: false', () => {
    const result = toOpenAIStrictSchema(geminiSchema)
    const todos = result.properties as Record<string, Record<string, unknown>>
    const items = todos['todos'].items as Record<string, unknown>
    assert.equal(items.additionalProperties, false)
  })

  it('nullable todo fields use anyOf union', () => {
    const result = toOpenAIStrictSchema(geminiSchema)
    const todos = result.properties as Record<string, Record<string, unknown>>
    const itemProps = (todos['todos'].items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
    assert.deepEqual(itemProps['assignee'].anyOf, [{ type: 'string' }, { type: 'null' }])
    assert.deepEqual(itemProps['source_segment_index'].anyOf, [{ type: 'integer' }, { type: 'null' }])
  })

  it('non-nullable fields remain plain type strings', () => {
    const result = toOpenAIStrictSchema(geminiSchema)
    const props = result.properties as Record<string, Record<string, unknown>>
    assert.equal(props['summary'].type, 'string')
    assert.equal(props['summary'].anyOf, undefined)
  })
})

// ---------------------------------------------------------------------------
// generateStructured — happy path
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.generateStructured — success', () => {
  it('returns parsed data, rawText, usage, and keyId', async () => {
    const { pool } = makePool([{
      choices: [{ message: { content: '{"ok":true}', refusal: null } }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }])
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages:  'q',
      schema:    { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
      model:     'gpt-4o',
      parse:     JSON.parse as (s: string) => { ok: boolean },
      operation: 'test',
    })

    assert.deepEqual(result.data, { ok: true })
    assert.equal(result.rawText, '{"ok":true}')
    assert.equal(result.inputTokens,  20)
    assert.equal(result.outputTokens,  8)
    assert.equal(result.totalTokens,  28)
    assert.equal(result.keyId, 'key-1')
  })

  it('makes exactly one create() call on success', async () => {
    const { pool, calls } = makePool([{
      choices: [{ message: { content: '"done"', refusal: null } }],
    }])
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: String, operation: 'test',
    })

    assert.equal(calls.length, 1)
  })

  it('sends response_format.json_schema.strict = true', async () => {
    const { pool, calls } = makePool([{
      choices: [{ message: { content: '{}', refusal: null } }],
    }])
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => unknown, operation: 'op1',
    })

    const rf = calls[0].params.response_format
    assert.ok(rf, 'response_format should be set')
    assert.equal(rf?.type, 'json_schema')
    assert.equal(rf?.json_schema?.strict, true)
    assert.equal(rf?.json_schema?.name, 'op1')
  })

  it('includes systemInstruction as a system message', async () => {
    const { pool, calls } = makePool([{
      choices: [{ message: { content: '{}', refusal: null } }],
    }])
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateStructured({
      messages: 'user-prompt',
      schema: {}, model: 'gpt-4o',
      systemInstruction: 'You are a test assistant.',
      parse: JSON.parse as (s: string) => unknown, operation: 'test',
    })

    const msgs = calls[0].params.messages
    assert.equal(msgs[0].role, 'system')
    assert.equal(msgs[0].content, 'You are a test assistant.')
    assert.equal(msgs[1].role, 'user')
    assert.equal(msgs[1].content, 'user-prompt')
  })

  it('omits system message when systemInstruction is not provided', async () => {
    const { pool, calls } = makePool([{
      choices: [{ message: { content: '{}', refusal: null } }],
    }])
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => unknown, operation: 'test',
    })

    const msgs = calls[0].params.messages
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].role, 'user')
  })

  it('keyId is null when pool passes null', async () => {
    const client = makeMockClient([{ choices: [{ message: { content: '"x"', refusal: null } }] }])
    const pool: OpenAIPool = { call: (fn) => fn(client, null) }
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: String, operation: 'test',
    })

    assert.equal(result.keyId, null)
  })
})

// ---------------------------------------------------------------------------
// generateStructured — parse-fail retry (same key invariant)
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.generateStructured — parse-fail retry', () => {
  it('retries with retryMessages when parse() throws', async () => {
    const calls: CapturedCall[] = []
    const client = makeMockClient([
      { choices: [{ message: { content: 'INVALID', refusal: null } }] },
      { choices: [{ message: { content: '{"x":2}', refusal: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ], calls)
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'first', retryMessages: 'strict',
      schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => { x: number },
      operation: 'test',
    })

    assert.deepEqual(result.data, { x: 2 })
    assert.equal(result.totalTokens, 8)
    assert.equal(calls.length, 2)
  })

  it('uses the same pool.call() for both attempts (same key)', async () => {
    let poolCallCount = 0
    const calls: CapturedCall[] = []
    const client = makeMockClient([
      { choices: [{ message: { content: 'BAD', refusal: null } }] },
      { choices: [{ message: { content: '{}', refusal: null } }] },
    ], calls)
    const pool: OpenAIPool = {
      call: (fn) => { poolCallCount++; return fn(client, 'k') },
    }
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateStructured({
      messages: 'first', retryMessages: 'retry',
      schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => unknown, operation: 'test',
    })

    assert.equal(poolCallCount, 1, 'one pool.call() — same key for both attempts')
    assert.equal(calls.length, 2, 'two create() calls')
  })

  it('sends retryMessages (not original) on the second create() call', async () => {
    const calls: CapturedCall[] = []
    const client = makeMockClient([
      { choices: [{ message: { content: 'BAD', refusal: null } }] },
      { choices: [{ message: { content: '{}', refusal: null } }] },
    ], calls)
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateStructured({
      messages: 'ORIGINAL', retryMessages: 'STRICT',
      schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => unknown, operation: 'test',
    })

    const firstMsg  = calls[0].params.messages.at(-1)?.content
    const secondMsg = calls[1].params.messages.at(-1)?.content
    assert.equal(firstMsg,  'ORIGINAL')
    assert.equal(secondMsg, 'STRICT')
  })

  it('rawText reflects the retry response text', async () => {
    const client = makeMockClient([
      { choices: [{ message: { content: 'BAD', refusal: null } }] },
      { choices: [{ message: { content: '{"r":1}', refusal: null } }] },
    ])
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q', retryMessages: 'strict',
      schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => unknown, operation: 'test',
    })

    assert.equal(result.rawText, '{"r":1}')
  })

  it('throws when parse fails and no retryMessages provided', async () => {
    const { pool } = makePool([{ choices: [{ message: { content: 'BAD', refusal: null } }] }])
    const adapter = new OpenAIAdapter(pool)

    await assert.rejects(
      () => adapter.generateStructured({
        messages: 'q', schema: {}, model: 'gpt-4o',
        parse: JSON.parse as (s: string) => unknown, operation: 'test',
      }),
      /SyntaxError/,
    )
  })

  it('throws when both attempts fail', async () => {
    const client = makeMockClient([
      { choices: [{ message: { content: 'BAD1', refusal: null } }] },
      { choices: [{ message: { content: 'BAD2', refusal: null } }] },
    ])
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    await assert.rejects(() =>
      adapter.generateStructured({
        messages: 'first', retryMessages: 'retry',
        schema: {}, model: 'gpt-4o',
        parse: JSON.parse as (s: string) => unknown, operation: 'test',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Refusal handling — distinct from parse-fail, must not trigger retry
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.generateStructured — refusal', () => {
  it('throws RefusalError when message.refusal is set', async () => {
    const { pool } = makePool([{
      choices: [{ message: { content: null, refusal: 'I cannot help with that.' } }],
    }])
    const adapter = new OpenAIAdapter(pool)

    await assert.rejects(
      () => adapter.generateStructured({
        messages: 'q', schema: {}, model: 'gpt-4o',
        parse: JSON.parse as (s: string) => unknown, operation: 'test',
      }),
      (err: unknown) => err instanceof RefusalError && /cannot help/.test(err.message),
    )
  })

  it('RefusalError does NOT trigger the parse-fail retry path', async () => {
    const calls: CapturedCall[] = []
    const client = makeMockClient([
      { choices: [{ message: { content: null, refusal: 'Declined.' } }] },
    ], calls)
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    await assert.rejects(
      () => adapter.generateStructured({
        messages: 'q', retryMessages: 'retry',
        schema: {}, model: 'gpt-4o',
        parse: JSON.parse as (s: string) => unknown, operation: 'test',
      }),
      RefusalError,
    )

    assert.equal(calls.length, 1, 'refusal must not trigger a second create() call')
  })

  it('RefusalError has name "RefusalError" (used by pool isNonRetryable)', () => {
    const err = new RefusalError('test refusal')
    assert.equal(err.name, 'RefusalError')
  })
})

// ---------------------------------------------------------------------------
// Usage metadata parity with GeminiAdapter
// ---------------------------------------------------------------------------

describe('OpenAIAdapter — UsageMetadata parity', () => {
  it('maps prompt_tokens → inputTokens, completion_tokens → outputTokens, total_tokens → totalTokens', async () => {
    const { pool } = makePool([{
      choices: [{ message: { content: '"ok"', refusal: null } }],
      usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    }])
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: String, operation: 'test',
    })

    assert.equal(result.inputTokens,  30)
    assert.equal(result.outputTokens, 12)
    assert.equal(result.totalTokens,  42)
  })

  it('all token fields are undefined when usage is absent', async () => {
    const client: OpenAIClient = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: '"x"', refusal: null } }],
        // no usage field
      }) } },
    }
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: String, operation: 'test',
    })

    assert.equal(result.inputTokens,  undefined)
    assert.equal(result.outputTokens, undefined)
    assert.equal(result.totalTokens,  undefined)
  })
})

// ---------------------------------------------------------------------------
// generateText
// ---------------------------------------------------------------------------

describe('OpenAIAdapter.generateText', () => {
  it('returns text and usage', async () => {
    const { pool } = makePool([{
      choices: [{ message: { content: 'Hello world', refusal: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }])
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateText({ messages: 'ping', model: 'gpt-4o' })

    assert.equal(result.text, 'Hello world')
    assert.equal(result.inputTokens,  5)
    assert.equal(result.outputTokens, 2)
    assert.equal(result.totalTokens,  7)
    assert.equal(result.keyId, 'key-1')
  })

  it('returns empty string when content is null', async () => {
    const client: OpenAIClient = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: null, refusal: null } }],
      }) } },
    }
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateText({ messages: 'q', model: 'gpt-4o' })
    assert.equal(result.text, '')
  })

  it('does NOT set response_format on generateText calls', async () => {
    const calls: CapturedCall[] = []
    const client = makeMockClient([{
      choices: [{ message: { content: 'hi', refusal: null } }],
    }], calls)
    const { pool } = makeMockPool(client)
    const adapter = new OpenAIAdapter(pool)

    await adapter.generateText({ messages: 'q', model: 'gpt-4o' })

    assert.equal(calls[0].params.response_format, undefined)
  })
})

// ---------------------------------------------------------------------------
// OpenAI-compatible reuse path (baseUrl parameterisation)
// ---------------------------------------------------------------------------

describe('OpenAIAdapter — reuse path (custom baseUrl)', () => {
  it('accepts a custom baseUrl at construction time', () => {
    const mockPool: OpenAIPool = { call: async (fn) => fn(makeMockClient([]), null) }
    // Custom baseUrl — same adapter class works for any OpenAI-compatible provider
    // (Grok, Kimi, etc.) via a registry + key-pool entry only — no new adapter code.
    assert.doesNotThrow(() => new OpenAIAdapter(mockPool, 'https://api.x.ai/v1'))
  })

  it('uses the injected pool regardless of baseUrl', async () => {
    let poolCalled = false
    const pool: OpenAIPool = {
      call: async (fn) => {
        poolCalled = true
        return fn(makeMockClient([{
          choices: [{ message: { content: '"ok"', refusal: null } }],
        }]), null)
      },
    }
    const adapter = new OpenAIAdapter(pool, 'https://api.custom.example/v1')

    await adapter.generateText({ messages: 'q', model: 'gpt-4o' })
    assert.ok(poolCalled, 'injected pool must be used')
  })
})

// ---------------------------------------------------------------------------
// Output parity — OpenAIAdapter and GeminiAdapter return the same shape
// ---------------------------------------------------------------------------

describe('Output parity — OpenAIAdapter vs GeminiAdapter', () => {
  it('generateStructured result has the same shape as GeminiAdapter output', async () => {
    const { pool } = makePool([{
      choices: [{ message: { content: '{"summary":"s","todos":[]}', refusal: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }])
    const adapter = new OpenAIAdapter(pool)

    const result = await adapter.generateStructured({
      messages: 'q', schema: {}, model: 'gpt-4o',
      parse: JSON.parse as (s: string) => { summary: string; todos: unknown[] },
      operation: 'analyze',
    })

    // Same fields as GeminiAdapter output: data, rawText, inputTokens, outputTokens, totalTokens, keyId
    assert.ok('data' in result)
    assert.ok('rawText' in result)
    assert.ok('inputTokens'  in result)
    assert.ok('outputTokens' in result)
    assert.ok('totalTokens'  in result)
    assert.ok('keyId' in result)
    // Values match expectations
    assert.deepEqual(result.data, { summary: 's', todos: [] })
    assert.equal(result.rawText, '{"summary":"s","todos":[]}')
  })
})
