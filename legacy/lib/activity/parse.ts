// Pure helper — no I/O, safe to unit-test directly.

export type ActivityQueryParams = {
  page: number
  perPage: number
  userId: string | null
  eventType: string | null
  from: string | null
  to: string | null
}

export function parseActivityQueryParams(searchParams: URLSearchParams): ActivityQueryParams {
  const page    = Math.max(1,   parseInt(searchParams.get('page')    ?? '1',  10))
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('perPage') ?? '20', 10)))
  const userId    = searchParams.get('userId')    ?? null
  const eventType = searchParams.get('eventType') ?? null
  const from      = searchParams.get('from')      ?? null
  const to        = searchParams.get('to')        ?? null
  return { page, perPage, userId, eventType, from, to }
}
