// Version history of a meeting's summary / notes (PRO-06, part 6b). Pure.
// Owner decisions 2026-11-09: versions cannot be deleted one by one; the editor's username is
// shown to everyone who can read the meeting.
import { ApiError } from '../../api/errors'

export type VersionSource = 'ai' | 'user' | 'restore'

export interface VersionRow {
  id: string
  source: VersionSource
  editedByUsername: string | null
  createdAt: string
  length: number
}

export interface VersionText {
  id: string
  source: VersionSource
  createdAt: string
  content: string
  contentHash: string
}

const SOURCES: readonly string[] = ['ai', 'user', 'restore']
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isSource = (v: unknown): v is VersionSource => typeof v === 'string' && SOURCES.includes(v)
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** `GET /meetings/{id}/content-versions` → rows to show, newest first (the API's order). */
export function normalizeVersions(body: unknown): VersionRow[] {
  const list = isRecord(body) ? body.versions : null
  if (!Array.isArray(list)) return []
  const out: VersionRow[] = []
  for (const r of list) {
    if (!isRecord(r) || typeof r.id !== 'string' || !isSource(r.source) || !isDate(r.createdAt)) continue
    const name = r.source !== 'ai' && typeof r.editedByUsername === 'string' && r.editedByUsername ? r.editedByUsername : null
    const length = typeof r.length === 'number' && Number.isFinite(r.length) ? r.length : 0
    out.push({ id: r.id, source: r.source, editedByUsername: name, createdAt: r.createdAt, length })
  }
  return out
}

/** `GET /meetings/{id}/content-versions/{versionId}` → the text, or null if malformed. */
export function normalizeVersion(body: unknown): VersionText | null {
  if (!isRecord(body)) return null
  const { id, source, createdAt, content, contentHash } = body
  if (typeof id !== 'string' || !isSource(source) || !isDate(createdAt)) return null
  if (typeof content !== 'string' || typeof contentHash !== 'string' || !contentHash) return null
  return { id, source, createdAt, content, contentHash }
}

/** A person's text may show its https links; AI text never (CLAUDE.md §0.10, PRO-06). */
export function versionLinks(source: VersionSource): boolean {
  return source !== 'ai'
}

export function historyErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'detail.history.errors.failed'
  if (err.status === 0) return 'detail.errors.network'
  if (err.status === 429) return 'detail.errors.rateLimited'
  if (err.status === 403) return 'detail.errors.forbidden'
  if (err.status === 404) return 'detail.history.errors.gone'
  if (err.code === 'content_changed') return 'detail.history.errors.changed'
  if (err.status === 409) return 'detail.edit.errors.notDone'
  return 'detail.history.errors.failed'
}
