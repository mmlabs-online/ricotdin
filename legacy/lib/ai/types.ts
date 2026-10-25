// Provider-abstraction types for AIP-01 / AIP-03.
// SCOPE: covers generation only — meeting analysis + RAG answer synthesis.
// Embeddings (Gemini, pinned by vector schema) and STT (Speechmatics) are NOT abstracted.

export interface UsageCtx {
  meetingId?: string | null
  userId?: string | null
}

/** Per-meeting model lock (AIP-03): the provider+model pair recorded at pipeline start. */
export interface ModelCtx {
  provider: string
  model: string
}

export interface UsageMetadata {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  keyId: string | null
}

export interface CapabilityFlags {
  /** Provider natively enforces a JSON schema in the response (not just a hint). */
  hardJsonSchema: boolean
  /** Provider can accept audio input. Always false for generation providers — audio goes via Speechmatics. */
  acceptsAudio: boolean
  /** Approximate context window size in tokens. */
  maxContextTokens: number
}

export interface ProviderAdapter {
  /**
   * JSON-mode generation with optional same-key parse-fail retry.
   *
   * `parse(rawText)` is called on the response. If it throws AND `retryMessages`
   * is provided, the adapter retries on the SAME provider key (the retry is a
   * prompt change, not a key rotation — both calls happen inside one pool.call()).
   * If the retry also fails, the error propagates.
   *
   * logUsage is called internally after each provider request.
   */
  generateStructured<T>(opts: {
    messages: string
    schema: unknown
    model: string
    systemInstruction?: string
    parse: (rawText: string) => T
    retryMessages?: string
    operation: string
    ctx?: UsageCtx
  }): Promise<{ data: T; rawText: string } & UsageMetadata>

  /** Plain text generation — used by connectivity checks. */
  generateText(opts: {
    messages: string
    model: string
  }): Promise<{ text: string } & UsageMetadata>
}
