// The v2 API answers errors as {"error": {code, message}} (CLAUDE.md §0.2).

const MAX_MESSAGE = 500

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function apiErrorFrom(status: number, body: unknown): ApiError {
  const fallback = status === 0 ? 'network' : `http_${status}`
  const envelope =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof envelope === 'object' && envelope !== null) {
    const { code, message } = envelope as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && code) {
      const text = typeof message === 'string' ? message.slice(0, MAX_MESSAGE) : ''
      return new ApiError(status, code.slice(0, 100), text)
    }
  }
  return new ApiError(status, fallback, '')
}
