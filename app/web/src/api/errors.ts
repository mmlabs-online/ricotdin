// The v2 API answers errors as {"error": {code, message}} (CLAUDE.md §0.2).

const MAX_MESSAGE = 500

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Machine-readable extras some APIs add (mmlabs: `join_available`); never shown as text. */
  readonly details: unknown

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function apiErrorFrom(status: number, body: unknown): ApiError {
  const fallback = status === 0 ? 'network' : `http_${status}`
  const envelope =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof envelope === 'object' && envelope !== null) {
    const { code, message, details } = envelope as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof code === 'string' && code) {
      const text = typeof message === 'string' ? message.slice(0, MAX_MESSAGE) : ''
      return new ApiError(status, code.slice(0, 100), text, details ?? null)
    }
  }
  return new ApiError(status, fallback, '')
}
