// Pure parsing helpers for GET /api/admin/audit-logs query params.
// No I/O — fully unit-testable in isolation.

export interface AuditQueryParams {
  page: number
  perPage: number
  actor: string | null
  action: string | null
  from: string | null
  to: string | null
}

function isValidDateString(s: string): boolean {
  // Accept anything parseable by Date that is not NaN
  return !isNaN(Date.parse(s))
}

export function parseAuditQueryParams(params: URLSearchParams): AuditQueryParams {
  const rawPage    = parseInt(params.get('page')    ?? '', 10)
  const rawPerPage = parseInt(params.get('perPage') ?? '', 10)

  const page    = isNaN(rawPage)    ? 1  : Math.max(1, rawPage)
  const perPage = isNaN(rawPerPage) ? 20 : Math.min(100, Math.max(1, rawPerPage))

  const actor  = params.get('actor')  || null
  const action = params.get('action') || null

  const rawFrom = params.get('from')
  const rawTo   = params.get('to')
  const from = rawFrom && isValidDateString(rawFrom) ? rawFrom : null
  const to   = rawTo   && isValidDateString(rawTo)   ? rawTo   : null

  return { page, perPage, actor, action, from, to }
}
