// SERVER ONLY — reads OpenAI API keys via the pool. Never import from client components.
//
// OpenAI implementation of ProviderAdapter.
//
// Uses OpenAI Structured Outputs (json_schema, strict: true) for generateStructured,
// ensuring hard schema enforcement — not just a hint. The same parse-fail retry
// policy as GeminiAdapter is applied: if parse() throws and retryMessages is
// provided, the adapter retries on the SAME key (inside one pool.call()).
//
// Constructor accepts an optional pool and baseUrl for unit-test injection and for
// OpenAI-compatible providers (Grok, Kimi, etc.) respectively — same adapter code,
// different baseUrl + pool at registry time. No new adapter subclass needed.
//
// Schema translation: Gemini schemas use uppercase type names and `nullable: true`.
// OpenAI strict mode requires lowercase types and `anyOf: [{type}, {type: "null"}]`
// for nullable fields, plus `additionalProperties: false` on every object and all
// properties listed in `required`. toOpenAIStrictSchema() handles this conversion.

import { openAIPool } from '@/lib/openai/pool'
import { logUsage } from '@/lib/usage/logUsage'
import { logger } from '@/lib/logger'
import type { ProviderAdapter, UsageCtx, UsageMetadata } from '../types'

// ---------------------------------------------------------------------------
// RefusalError — model declined to respond (message.refusal set).
// Distinct from a parse failure: it must NOT trigger the parse-fail retry path.
// The pool surfaces it immediately (isNonRetryable via name check in openai/pool.ts).
// ---------------------------------------------------------------------------

export class RefusalError extends Error {
  constructor(refusal: string) {
    super(`Model refused: ${refusal}`)
    this.name = 'RefusalError'
  }
}

// ---------------------------------------------------------------------------
// Narrow interfaces — the subset of the OpenAI SDK that this adapter uses.
// Defined here so tests can inject minimal mocks without importing the SDK.
// ---------------------------------------------------------------------------

export interface OpenAICompletionUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface OpenAIChatMessage {
  content: string | null
  refusal?: string | null
}

export interface OpenAIChatCompletion {
  choices: Array<{ message: OpenAIChatMessage }>
  usage?: OpenAICompletionUsage
}

export interface OpenAICreateParams {
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  response_format?: {
    type: 'json_schema'
    json_schema: {
      name: string
      schema: Record<string, unknown>
      strict: boolean
    }
  }
}

export interface OpenAIClient {
  chat: {
    completions: {
      create(params: OpenAICreateParams): Promise<OpenAIChatCompletion>
    }
  }
}

export interface OpenAIPool {
  call<T>(fn: (client: OpenAIClient, keyId: string | null) => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Schema translation — Gemini schema → OpenAI strict JSON Schema
//
// Differences:
//   - Gemini type names are uppercase ("OBJECT", "STRING", "INTEGER"…);
//     OpenAI requires lowercase.
//   - Gemini `nullable: true` becomes OpenAI `anyOf: [{type}, {type: "null"}]`.
//   - OpenAI strict mode requires `additionalProperties: false` and all properties
//     listed in `required` on every object node.
// ---------------------------------------------------------------------------

const GEMINI_TYPE_MAP: Record<string, string> = {
  OBJECT:  'object',
  ARRAY:   'array',
  STRING:  'string',
  NUMBER:  'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  NULL:    'null',
}

type JsonSchemaNode = Record<string, unknown>

/**
 * Translates a Gemini schema node (or plain JSON Schema) to an OpenAI strict
 * JSON Schema node. Pure function — safe to test in isolation.
 */
export function toOpenAIStrictSchema(node: unknown): JsonSchemaNode {
  if (typeof node !== 'object' || node === null) return {}
  const n = node as Record<string, unknown>

  const rawType =
    typeof n.type === 'string'
      ? (GEMINI_TYPE_MAP[n.type] ?? n.type.toLowerCase())
      : undefined
  const nullable = Boolean(n.nullable)
  const result: JsonSchemaNode = {}

  if (typeof n.description === 'string') result.description = n.description

  if (rawType === 'object' && typeof n.properties === 'object' && n.properties !== null) {
    const props = n.properties as Record<string, unknown>
    result.type = 'object'
    result.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, toOpenAIStrictSchema(v)]),
    )
    // OpenAI strict: ALL properties must be required.
    result.required = Array.isArray(n.required) ? n.required : Object.keys(props)
    result.additionalProperties = false
  } else if (rawType === 'array') {
    result.type = 'array'
    if (n.items !== undefined) result.items = toOpenAIStrictSchema(n.items)
  } else if (nullable && rawType && rawType !== 'null') {
    // Nullable leaf field → OpenAI anyOf union pattern.
    result.anyOf = [{ type: rawType }, { type: 'null' }]
  } else if (rawType) {
    result.type = rawType
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessages(
  content: string,
  systemInstruction?: string,
): OpenAICreateParams['messages'] {
  const msgs: OpenAICreateParams['messages'] = []
  if (systemInstruction) msgs.push({ role: 'system', content: systemInstruction })
  msgs.push({ role: 'user', content })
  return msgs
}

function mapUsage(
  usage: OpenAICompletionUsage | undefined,
  keyId: string | null,
): UsageMetadata {
  return {
    inputTokens:  usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
    totalTokens:  usage?.total_tokens,
    keyId,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements ProviderAdapter {
  private readonly pool: OpenAIPool
  private readonly providerLabel: string

  /**
   * @param pool          Injectable pool — default is the shared openAIPool singleton.
   *                      Pass a mock here in tests; pass a custom pool for a different
   *                      baseUrl (e.g. Grok at api.x.ai) in the registry.
   * @param baseUrl       Informational only when pool is provided. Used by registry
   *                      entries to document which endpoint this adapter targets.
   * @param providerLabel Label used for usage logging — defaults to 'openai'.
   *                      OpenAI-compatible providers (e.g. 'grok') pass their own so
   *                      usage_log rows are attributed to the correct provider.
   */
  constructor(
    pool: OpenAIPool = openAIPool as unknown as OpenAIPool,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    baseUrl?: string,
    providerLabel = 'openai',
  ) {
    this.pool = pool
    this.providerLabel = providerLabel
  }

  async generateStructured<T>(opts: {
    messages: string
    schema: unknown
    model: string
    systemInstruction?: string
    parse: (rawText: string) => T
    retryMessages?: string
    operation: string
    ctx?: UsageCtx
  }): Promise<{ data: T; rawText: string } & UsageMetadata> {
    const schema = toOpenAIStrictSchema(opts.schema)

    return this.pool.call(async (client, keyId) => {
      // ── First attempt ───────────────────────────────────────────────────────
      const completion = await client.chat.completions.create({
        model: opts.model,
        messages: buildMessages(opts.messages, opts.systemInstruction),
        response_format: {
          type: 'json_schema',
          json_schema: { name: opts.operation, schema, strict: true },
        },
      })

      const choice = completion.choices[0]
      if (choice.message.refusal) throw new RefusalError(choice.message.refusal)

      const rawText = choice.message.content ?? ''
      const usage = completion.usage

      logUsage({
        provider: this.providerLabel,
        model: opts.model,
        operation: opts.operation,
        unit: 'tokens',
        quantity: usage?.total_tokens ?? 0,
        input_tokens:  usage?.prompt_tokens,
        output_tokens: usage?.completion_tokens,
        total_tokens:  usage?.total_tokens,
        meeting_id: opts.ctx?.meetingId,
        user_id:    opts.ctx?.userId,
        key_id: keyId,
      })

      try {
        return { data: opts.parse(rawText), rawText, ...mapUsage(usage, keyId) }
      } catch (parseErr) {
        if (!opts.retryMessages) throw parseErr

        // ── Retry with stricter prompt on the same key ──────────────────────
        // Staying inside pool.call() guarantees the same API key for both attempts.
        logger.warn('[openai adapter] first parse failed; retrying with strict prompt', {
          detail: String(parseErr),
        })

        const completion2 = await client.chat.completions.create({
          model: opts.model,
          messages: buildMessages(opts.retryMessages, opts.systemInstruction),
          response_format: {
            type: 'json_schema',
            json_schema: { name: opts.operation, schema, strict: true },
          },
        })

        const choice2 = completion2.choices[0]
        if (choice2.message.refusal) throw new RefusalError(choice2.message.refusal)

        const rawText2 = choice2.message.content ?? ''
        const usage2 = completion2.usage

        logUsage({
          provider: this.providerLabel,
          model: opts.model,
          operation: opts.operation,
          unit: 'tokens',
          quantity: usage2?.total_tokens ?? 0,
          input_tokens:  usage2?.prompt_tokens,
          output_tokens: usage2?.completion_tokens,
          total_tokens:  usage2?.total_tokens,
          meeting_id: opts.ctx?.meetingId,
          user_id:    opts.ctx?.userId,
          key_id: keyId,
        })

        return { data: opts.parse(rawText2), rawText: rawText2, ...mapUsage(usage2, keyId) }
      }
    })
  }

  async generateText(opts: {
    messages: string
    model: string
  }): Promise<{ text: string } & UsageMetadata> {
    return this.pool.call(async (client, keyId) => {
      const completion = await client.chat.completions.create({
        model: opts.model,
        messages: [{ role: 'user', content: opts.messages }],
      })
      const text = completion.choices[0].message.content ?? ''
      return { text, ...mapUsage(completion.usage, keyId) }
    })
  }
}
