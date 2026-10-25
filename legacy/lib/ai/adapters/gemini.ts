// SERVER ONLY — reads Gemini API keys via the pool. Never import from client components.
//
// Gemini implementation of ProviderAdapter.
//
// The parse-fail retry (stricter prompt, same key) from the old analyze.ts lives
// here. Both generateContent calls happen inside a single pool.call() callback so
// they share the same API key — no pool rotation between attempts.
//
// Constructor accepts an optional pool for unit-test injection (no live keys needed).

import { type Schema } from '@google/genai'
import { geminiPool } from '@/lib/gemini/pool'
import { logUsage } from '@/lib/usage/logUsage'
import { logger } from '@/lib/logger'
import type { ProviderAdapter, UsageCtx, UsageMetadata } from '../types'

// ---------------------------------------------------------------------------
// Narrow interfaces — the subset of GoogleGenAI that this adapter uses.
// Defined separately so tests can inject a minimal mock without importing the SDK.
// ---------------------------------------------------------------------------

export interface GeminiClientResponse {
  text?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

export interface GeminiClient {
  models: {
    generateContent(opts: {
      model: string
      contents: string
      config?: {
        systemInstruction?: string
        responseMimeType?: string
        responseSchema?: unknown
      }
    }): Promise<GeminiClientResponse>
  }
}

/** Injectable pool interface — real code uses geminiPool; tests inject a mock. */
export interface GeminiPool {
  call<T>(fn: (ai: GeminiClient, keyId: string | null) => Promise<T>): Promise<T>
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements ProviderAdapter {
  private readonly pool: GeminiPool

  constructor(pool: GeminiPool = geminiPool as unknown as GeminiPool) {
    this.pool = pool
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
    return this.pool.call(async (ai, keyId) => {
      // ── First attempt ─────────────────────────────────────────────────────
      const response = await ai.models.generateContent({
        model: opts.model,
        contents: opts.messages,
        config: {
          systemInstruction: opts.systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: opts.schema as Schema,
        },
      })

      const rawText = response.text ?? ''
      const meta = response.usageMetadata

      logUsage({
        provider: 'gemini',
        model: opts.model,
        operation: opts.operation,
        unit: 'tokens',
        quantity: meta?.totalTokenCount ?? 0,
        input_tokens:  meta?.promptTokenCount     ?? undefined,
        output_tokens: meta?.candidatesTokenCount ?? undefined,
        total_tokens:  meta?.totalTokenCount      ?? undefined,
        meeting_id: opts.ctx?.meetingId,
        user_id:    opts.ctx?.userId,
        key_id: keyId,
      })

      try {
        return {
          data: opts.parse(rawText),
          rawText,
          inputTokens:  meta?.promptTokenCount,
          outputTokens: meta?.candidatesTokenCount,
          totalTokens:  meta?.totalTokenCount,
          keyId,
        }
      } catch (parseErr) {
        if (!opts.retryMessages) throw parseErr

        // ── Retry with stricter prompt on the same key ─────────────────────
        // Staying inside pool.call() guarantees the same API key is used.
        logger.warn('[gemini adapter] first parse failed; retrying with strict prompt', {
          detail: String(parseErr),
        })

        const response2 = await ai.models.generateContent({
          model: opts.model,
          contents: opts.retryMessages,
          config: {
            systemInstruction: opts.systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: opts.schema as Schema,
          },
        })

        const rawText2 = response2.text ?? ''
        const meta2 = response2.usageMetadata

        logUsage({
          provider: 'gemini',
          model: opts.model,
          operation: opts.operation,
          unit: 'tokens',
          quantity: meta2?.totalTokenCount ?? 0,
          input_tokens:  meta2?.promptTokenCount     ?? undefined,
          output_tokens: meta2?.candidatesTokenCount ?? undefined,
          total_tokens:  meta2?.totalTokenCount      ?? undefined,
          meeting_id: opts.ctx?.meetingId,
          user_id:    opts.ctx?.userId,
          key_id: keyId,
        })

        return {
          data: opts.parse(rawText2),
          rawText: rawText2,
          inputTokens:  meta2?.promptTokenCount,
          outputTokens: meta2?.candidatesTokenCount,
          totalTokens:  meta2?.totalTokenCount,
          keyId,
        }
      }
    })
  }

  async generateText(opts: {
    messages: string
    model: string
  }): Promise<{ text: string } & UsageMetadata> {
    return this.pool.call(async (ai, keyId) => {
      const response = await ai.models.generateContent({
        model: opts.model,
        contents: opts.messages,
      })
      const text = response.text ?? ''
      const meta = response.usageMetadata
      return {
        text,
        inputTokens:  meta?.promptTokenCount,
        outputTokens: meta?.candidatesTokenCount,
        totalTokens:  meta?.totalTokenCount,
        keyId,
      }
    })
  }
}
