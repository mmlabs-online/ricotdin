// Unit tests for Admin Module (ADM) — ADM-01 through ADM-07.
//
// Coverage per feature:
//   ADM-01  User list        — search/filter, pagination, perPage clamp, "You" badge
//   ADM-02  Account mgmt     — ban-duration mapping, role-change detection, audit action names
//   ADM-03  Safety guards    — HTTP status codes on failures, exact error messages
//   ADM-04  Pipeline monitor — stuck detection, status aggregation, avg duration,
//                              job row shape (metadata-only), requeue eligibility
//   ADM-07  Audit log        — requestContext IP/UA extraction, audit payload structure
//
// Pattern: pure inline helpers mirror the logic in route handlers.
// No I/O, no Supabase, no HTTP mocks. Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkAdminRole,
  guardRoleDemotion,
  guardDisable,
  guardDelete,
  type GuardFail,
} from '../lib/admin/guards.js'

// ============================================================================
// ADM-01 — User list: filter, pagination, perPage clamp, self-badge
// ============================================================================

interface UserRow {
  id: string
  email: string
  username: string | null
  role: string
  disabled: boolean
}

function filterUsers(users: UserRow[], search: string): UserRow[] {
  const q = search.toLowerCase().trim()
  if (!q) return users
  return users.filter(
    (u) =>
      u.email.toLowerCase().includes(q) ||
      (u.username ?? '').toLowerCase().includes(q),
  )
}

function paginateUsers<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage
  return items.slice(start, start + perPage)
}

function clampPerPage(n: number, max = 100): number {
  return Math.min(Math.max(1, n), max)
}

function isSelfRow(userId: string, currentUserId: string): boolean {
  return userId === currentUserId
}

const SAMPLE_USERS: UserRow[] = [
  { id: 'u1', email: 'alice@example.com', username: 'alice',   role: 'admin', disabled: false },
  { id: 'u2', email: 'bob@example.com',   username: 'bob',     role: 'user',  disabled: false },
  { id: 'u3', email: 'carol@corp.io',     username: 'carol42', role: 'user',  disabled: true  },
  { id: 'u4', email: 'dave@corp.io',      username: null,      role: 'user',  disabled: false },
]

describe('ADM-01 filterUsers — search by email', () => {
  it('returns all users when search is empty', () => {
    assert.equal(filterUsers(SAMPLE_USERS, '').length, 4)
  })

  it('matches partial email substring case-insensitively', () => {
    const r = filterUsers(SAMPLE_USERS, 'CORP')
    assert.equal(r.length, 2)
    assert.equal(r[0].id, 'u3')
    assert.equal(r[1].id, 'u4')
  })

  it('matches exact email domain', () => {
    const r = filterUsers(SAMPLE_USERS, 'example.com')
    assert.equal(r.length, 2)
  })

  it('returns empty array when nothing matches', () => {
    assert.equal(filterUsers(SAMPLE_USERS, 'zzz').length, 0)
  })
})

describe('ADM-01 filterUsers — search by username', () => {
  it('matches partial username', () => {
    const r = filterUsers(SAMPLE_USERS, 'carol')
    assert.equal(r.length, 1)
    assert.equal(r[0].id, 'u3')
  })

  it('treats null username as empty string (no crash, falls through to email)', () => {
    const r = filterUsers(SAMPLE_USERS, 'dave')
    assert.equal(r.length, 1)
    assert.equal(r[0].id, 'u4')
  })

  it('trims whitespace from search query', () => {
    const r = filterUsers(SAMPLE_USERS, '  alice  ')
    assert.equal(r.length, 1)
    assert.equal(r[0].id, 'u1')
  })

  it('is case-insensitive on username', () => {
    const r = filterUsers(SAMPLE_USERS, 'BOB')
    assert.equal(r.length, 1)
    assert.equal(r[0].id, 'u2')
  })
})

describe('ADM-01 paginateUsers', () => {
  const items = [1, 2, 3, 4, 5, 6, 7]

  it('returns correct first page', () => {
    assert.deepEqual(paginateUsers(items, 1, 3), [1, 2, 3])
  })

  it('returns correct second page', () => {
    assert.deepEqual(paginateUsers(items, 2, 3), [4, 5, 6])
  })

  it('returns partial last page', () => {
    assert.deepEqual(paginateUsers(items, 3, 3), [7])
  })

  it('returns empty array when page exceeds total', () => {
    assert.deepEqual(paginateUsers(items, 5, 3), [])
  })

  it('page 1 with perPage = total returns all items', () => {
    assert.deepEqual(paginateUsers(items, 1, 7), items)
  })
})

describe('ADM-01 clampPerPage', () => {
  it('passes through values within range', () => {
    assert.equal(clampPerPage(20), 20)
  })

  it('clamps to max 100', () => {
    assert.equal(clampPerPage(500), 100)
  })

  it('clamps to min 1 for zero', () => {
    assert.equal(clampPerPage(0), 1)
  })

  it('clamps to min 1 for negative', () => {
    assert.equal(clampPerPage(-10), 1)
  })

  it('respects a custom max', () => {
    assert.equal(clampPerPage(50, 20), 20)
  })
})

describe('ADM-01 isSelfRow — "You" badge detection', () => {
  it('returns true when user ID equals current admin ID', () => {
    assert.equal(isSelfRow('abc-123', 'abc-123'), true)
  })

  it('returns false when IDs differ', () => {
    assert.equal(isSelfRow('abc-123', 'xyz-456'), false)
  })

  it('is case-sensitive (UUIDs are lowercase)', () => {
    assert.equal(isSelfRow('ABC', 'abc'), false)
  })
})

// ============================================================================
// ADM-02 — Account management: ban duration, role change detection, audit names
// ============================================================================

function banDuration(disabled: boolean): string {
  return disabled ? '876600h' : 'none'
}

function isDemotion(currentRole: string, newRole: string): boolean {
  return currentRole === 'admin' && newRole === 'user'
}

function isPromotion(currentRole: string, newRole: string): boolean {
  return currentRole === 'user' && newRole === 'admin'
}

const AUDIT_ACTIONS = {
  USER_ROLE_CHANGE:    'user.role_change',
  USER_DISABLE:        'user.disable',
  USER_ENABLE:         'user.enable',
  USER_DELETE:         'user.delete',
  USER_PASSWORD_RESET: 'user.password_reset',
  MEETING_REQUEUE:     'meeting.requeue',
} as const

describe('ADM-02 banDuration — disable/enable ban duration mapping', () => {
  it('disabled=true → 876600h (~100 years ban)', () => {
    assert.equal(banDuration(true), '876600h')
  })

  it('disabled=false → none (removes ban)', () => {
    assert.equal(banDuration(false), 'none')
  })

  it('calling banDuration(true) twice returns the same value (idempotent)', () => {
    assert.equal(banDuration(true), banDuration(true))
  })

  it('ban duration string contains "h" (hours suffix required by Supabase)', () => {
    assert.match(banDuration(true), /h$/)
  })
})

describe('ADM-02 role change detection', () => {
  it('admin → user is a demotion', () => {
    assert.equal(isDemotion('admin', 'user'), true)
  })

  it('user → user is NOT a demotion', () => {
    assert.equal(isDemotion('user', 'user'), false)
  })

  it('admin → admin is NOT a demotion', () => {
    assert.equal(isDemotion('admin', 'admin'), false)
  })

  it('user → admin is NOT a demotion', () => {
    assert.equal(isDemotion('user', 'admin'), false)
  })

  it('user → admin is a promotion', () => {
    assert.equal(isPromotion('user', 'admin'), true)
  })

  it('admin → admin is NOT a promotion', () => {
    assert.equal(isPromotion('admin', 'admin'), false)
  })

  it('admin → user is NOT a promotion', () => {
    assert.equal(isPromotion('admin', 'user'), false)
  })
})

describe('ADM-02 audit action names — dot-namespaced format', () => {
  it('role change action is user.role_change', () => {
    assert.equal(AUDIT_ACTIONS.USER_ROLE_CHANGE, 'user.role_change')
  })

  it('disable action is user.disable', () => {
    assert.equal(AUDIT_ACTIONS.USER_DISABLE, 'user.disable')
  })

  it('enable action is user.enable', () => {
    assert.equal(AUDIT_ACTIONS.USER_ENABLE, 'user.enable')
  })

  it('delete action is user.delete', () => {
    assert.equal(AUDIT_ACTIONS.USER_DELETE, 'user.delete')
  })

  it('password reset action is user.password_reset', () => {
    assert.equal(AUDIT_ACTIONS.USER_PASSWORD_RESET, 'user.password_reset')
  })

  it('requeue action is meeting.requeue', () => {
    assert.equal(AUDIT_ACTIONS.MEETING_REQUEUE, 'meeting.requeue')
  })

  it('all actions follow namespace.verb format', () => {
    for (const action of Object.values(AUDIT_ACTIONS)) {
      assert.match(action, /^\w+\.\w+$/, `"${action}" does not match namespace.verb`)
    }
  })
})

// ============================================================================
// ADM-03 — Safety constraints: HTTP 400 status + exact error message patterns
// ============================================================================

describe('ADM-03 guard failures return HTTP status 400', () => {
  it('guardRoleDemotion self-demotion → status 400', () => {
    const r = guardRoleDemotion('u1', 'u1', 'admin', 'user', 5)
    assert.equal(r.ok, false)
    assert.equal((r as GuardFail).status, 400)
  })

  it('guardRoleDemotion last-admin → status 400', () => {
    const r = guardRoleDemotion('u1', 'u2', 'admin', 'user', 1)
    assert.equal(r.ok, false)
    assert.equal((r as GuardFail).status, 400)
  })

  it('guardDisable self → status 400', () => {
    const r = guardDisable('u1', 'u1', 'user', 5)
    assert.equal(r.ok, false)
    assert.equal((r as GuardFail).status, 400)
  })

  it('guardDisable last-admin → status 400', () => {
    const r = guardDisable('u1', 'u2', 'admin', 1)
    assert.equal(r.ok, false)
    assert.equal((r as GuardFail).status, 400)
  })

  it('guardDelete self → status 400', () => {
    const r = guardDelete('u1', 'u1', 'admin', 5)
    assert.equal(r.ok, false)
    assert.equal((r as GuardFail).status, 400)
  })

  it('guardDelete last-admin → status 400', () => {
    const r = guardDelete('u1', 'u2', 'admin', 1)
    assert.equal(r.ok, false)
    assert.equal((r as GuardFail).status, 400)
  })
})

describe('ADM-03 guard error messages — user-visible strings', () => {
  it('self-demotion message mentions "yourself"', () => {
    const r = guardRoleDemotion('u1', 'u1', 'admin', 'user', 3)
    assert.match((r as GuardFail).message, /yourself/)
  })

  it('self-disable message mentions "own account"', () => {
    const r = guardDisable('u1', 'u1', 'admin', 3)
    assert.match((r as GuardFail).message, /own account/)
  })

  it('self-delete message mentions "own account"', () => {
    const r = guardDelete('u1', 'u1', 'admin', 3)
    assert.match((r as GuardFail).message, /own account/)
  })

  it('last-admin demotion message mentions "last"', () => {
    const r = guardRoleDemotion('u1', 'u2', 'admin', 'user', 1)
    assert.match((r as GuardFail).message, /last/)
  })

  it('last-admin disable message mentions "last"', () => {
    const r = guardDisable('u1', 'u2', 'admin', 1)
    assert.match((r as GuardFail).message, /last/)
  })

  it('last-admin delete message mentions "last"', () => {
    const r = guardDelete('u1', 'u2', 'admin', 1)
    assert.match((r as GuardFail).message, /last/)
  })
})

describe('ADM-03 guard passes — valid operations succeed', () => {
  it('promotion (user → admin) always passes', () => {
    assert.equal(guardRoleDemotion('u1', 'u2', 'user', 'admin', 1).ok, true)
  })

  it('demoting an admin when 2 admins exist passes', () => {
    assert.equal(guardRoleDemotion('u1', 'u2', 'admin', 'user', 2).ok, true)
  })

  it('disabling a regular user passes', () => {
    assert.equal(guardDisable('u1', 'u2', 'user', 1).ok, true)
  })

  it('disabling an admin when 2+ admins exist passes', () => {
    assert.equal(guardDisable('u1', 'u2', 'admin', 2).ok, true)
  })

  it('deleting a regular user passes', () => {
    assert.equal(guardDelete('u1', 'u2', 'user', 1).ok, true)
  })

  it('deleting an admin when 2+ admins exist passes', () => {
    assert.equal(guardDelete('u1', 'u2', 'admin', 2).ok, true)
  })

  it('checkAdminRole returns true for admin', () => {
    assert.equal(checkAdminRole({ role: 'admin' }), true)
  })

  it('checkAdminRole returns false for user → 403', () => {
    assert.equal(checkAdminRole({ role: 'user' }), false)
  })
})

// ============================================================================
// ADM-04 — Pipeline monitoring: stuck detection, aggregation, avg duration,
//           job row shape, requeue eligibility
// ============================================================================

const STUCK_THRESHOLD_MINUTES = 15

function isStuck(
  status: string,
  updatedAt: Date,
  now: Date,
  thresholdMinutes = STUCK_THRESHOLD_MINUTES,
): boolean {
  if (status !== 'processing') return false
  return now.getTime() - updatedAt.getTime() > thresholdMinutes * 60 * 1000
}

interface PipelineMeeting {
  status: 'pending' | 'processing' | 'done' | 'failed'
  created_at: string
  updated_at: string
}

function aggregateByStatus(
  meetings: PipelineMeeting[],
  now: Date,
  threshold = STUCK_THRESHOLD_MINUTES,
) {
  const counts = { pending: 0, processing: 0, done: 0, failed: 0, stuck: 0 }
  for (const m of meetings) {
    if (isStuck(m.status, new Date(m.updated_at), now, threshold)) {
      counts.stuck++
    } else {
      counts[m.status]++
    }
  }
  return counts
}

function avgProcessingSecs(
  doneMeetings: Array<{ created_at: string; updated_at: string }>,
): number {
  if (doneMeetings.length === 0) return 0
  const total = doneMeetings.reduce(
    (sum, m) =>
      sum +
      (new Date(m.updated_at).getTime() - new Date(m.created_at).getTime()) / 1000,
    0,
  )
  return total / doneMeetings.length
}

function canRequeueJob(status: string): boolean {
  return status === 'failed' || status === 'processing'
}

function buildJobRow(
  meeting: {
    id: string
    title: string
    status: string
    created_at: string
    updated_at: string
    error_message: string | null
  },
  ownerEmail: string,
  ownerUsername: string | null,
  now: Date,
) {
  const durationMs =
    new Date(meeting.updated_at).getTime() - new Date(meeting.created_at).getTime()
  return {
    id:              meeting.id,
    title:           meeting.title,
    status:          meeting.status,
    error_message:   meeting.error_message,
    owner_email:     ownerEmail,
    owner_username:  ownerUsername,
    duration_seconds: meeting.status === 'done' ? Math.round(durationMs / 1000) : null,
    is_stuck:        isStuck(meeting.status, new Date(meeting.updated_at), now),
  }
}

// Fixed reference time so all duration/stuck comparisons are deterministic
const NOW = new Date('2024-06-01T12:00:00Z')

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60 * 1000)
}

describe('ADM-04 isStuck — stuck detection (processing > 15 min)', () => {
  it('marks processing meeting updated 16 min ago as stuck', () => {
    assert.equal(isStuck('processing', minutesAgo(16), NOW), true)
  })

  it('does not mark processing meeting updated 14 min ago as stuck', () => {
    assert.equal(isStuck('processing', minutesAgo(14), NOW), false)
  })

  it('exactly at threshold (15 min) is NOT stuck (strict greater-than)', () => {
    assert.equal(isStuck('processing', minutesAgo(15), NOW), false)
  })

  it('done meeting is never stuck regardless of age', () => {
    assert.equal(isStuck('done', minutesAgo(60), NOW), false)
  })

  it('pending meeting is never stuck', () => {
    assert.equal(isStuck('pending', minutesAgo(60), NOW), false)
  })

  it('failed meeting is never stuck', () => {
    assert.equal(isStuck('failed', minutesAgo(60), NOW), false)
  })

  it('respects a custom threshold', () => {
    assert.equal(isStuck('processing', minutesAgo(6), NOW, 5), true)
    assert.equal(isStuck('processing', minutesAgo(4), NOW, 5), false)
  })
})

describe('ADM-04 aggregateByStatus', () => {
  const meetings: PipelineMeeting[] = [
    { status: 'done',       created_at: minutesAgo(120).toISOString(), updated_at: minutesAgo(100).toISOString() },
    { status: 'done',       created_at: minutesAgo(80).toISOString(),  updated_at: minutesAgo(60).toISOString()  },
    { status: 'failed',     created_at: minutesAgo(40).toISOString(),  updated_at: minutesAgo(30).toISOString()  },
    { status: 'pending',    created_at: minutesAgo(5).toISOString(),   updated_at: minutesAgo(5).toISOString()   },
    { status: 'processing', created_at: minutesAgo(20).toISOString(),  updated_at: minutesAgo(16).toISOString()  }, // stuck
    { status: 'processing', created_at: minutesAgo(10).toISOString(),  updated_at: minutesAgo(10).toISOString()  }, // not stuck
  ]

  it('counts done meetings', () => {
    assert.equal(aggregateByStatus(meetings, NOW).done, 2)
  })

  it('counts failed meetings', () => {
    assert.equal(aggregateByStatus(meetings, NOW).failed, 1)
  })

  it('counts pending meetings', () => {
    assert.equal(aggregateByStatus(meetings, NOW).pending, 1)
  })

  it('moves stuck processing into stuck bucket (not processing)', () => {
    const c = aggregateByStatus(meetings, NOW)
    assert.equal(c.stuck, 1)
    assert.equal(c.processing, 1)
  })

  it('sum of all buckets equals total meeting count', () => {
    const c = aggregateByStatus(meetings, NOW)
    assert.equal(c.done + c.failed + c.pending + c.processing + c.stuck, meetings.length)
  })

  it('returns all zeros for empty list', () => {
    const c = aggregateByStatus([], NOW)
    assert.deepEqual(c, { pending: 0, processing: 0, done: 0, failed: 0, stuck: 0 })
  })
})

describe('ADM-04 avgProcessingSecs', () => {
  it('returns 0 for empty list', () => {
    assert.equal(avgProcessingSecs([]), 0)
  })

  it('calculates duration for a single 120-second meeting', () => {
    const m = {
      created_at: new Date(0).toISOString(),
      updated_at: new Date(120_000).toISOString(),
    }
    assert.equal(avgProcessingSecs([m]), 120)
  })

  it('calculates average for multiple meetings', () => {
    const m1 = { created_at: new Date(0).toISOString(), updated_at: new Date(60_000).toISOString()  }  // 60s
    const m2 = { created_at: new Date(0).toISOString(), updated_at: new Date(120_000).toISOString() }  // 120s
    assert.equal(avgProcessingSecs([m1, m2]), 90)
  })

  it('is not affected by non-done meetings (caller pre-filters)', () => {
    // If caller passes only done meetings, result is correct
    const m = { created_at: new Date(0).toISOString(), updated_at: new Date(30_000).toISOString() }
    assert.equal(avgProcessingSecs([m]), 30)
  })
})

describe('ADM-04 buildJobRow — metadata-only shape', () => {
  const doneMeeting = {
    id:            'mtg-1',
    title:         'Q4 Planning',
    status:        'done',
    created_at:    new Date(0).toISOString(),
    updated_at:    new Date(90_000).toISOString(), // 90s
    error_message: null,
  }

  it('maps id, title, status', () => {
    const row = buildJobRow(doneMeeting, 'owner@example.com', 'ownr', NOW)
    assert.equal(row.id,     'mtg-1')
    assert.equal(row.title,  'Q4 Planning')
    assert.equal(row.status, 'done')
  })

  it('computes duration_seconds for done meetings', () => {
    const row = buildJobRow(doneMeeting, 'owner@example.com', 'ownr', NOW)
    assert.equal(row.duration_seconds, 90)
  })

  it('duration_seconds is null for non-done status', () => {
    const row = buildJobRow({ ...doneMeeting, status: 'processing' }, 'owner@example.com', 'ownr', NOW)
    assert.equal(row.duration_seconds, null)
  })

  it('includes owner_email and owner_username', () => {
    const row = buildJobRow(doneMeeting, 'owner@example.com', 'ownr', NOW)
    assert.equal(row.owner_email,    'owner@example.com')
    assert.equal(row.owner_username, 'ownr')
  })

  it('preserves null owner_username', () => {
    const row = buildJobRow(doneMeeting, 'owner@example.com', null, NOW)
    assert.equal(row.owner_username, null)
  })

  it('marks stuck processing meeting with is_stuck = true', () => {
    const stuckMeeting = { ...doneMeeting, status: 'processing', updated_at: minutesAgo(16).toISOString() }
    const row = buildJobRow(stuckMeeting, 'owner@example.com', null, NOW)
    assert.equal(row.is_stuck, true)
  })

  it('is_stuck = false for a recently updated processing meeting', () => {
    const activeMeeting = { ...doneMeeting, status: 'processing', updated_at: minutesAgo(5).toISOString() }
    const row = buildJobRow(activeMeeting, 'owner@example.com', null, NOW)
    assert.equal(row.is_stuck, false)
  })

  it('row does not contain transcript, summary, or notes fields', () => {
    const row = buildJobRow(doneMeeting, 'owner@example.com', 'ownr', NOW)
    assert.equal('transcript' in row, false)
    assert.equal('summary'    in row, false)
    assert.equal('notes'      in row, false)
  })
})

describe('ADM-04 canRequeueJob — requeue eligibility', () => {
  it('failed → eligible for requeue', () => {
    assert.equal(canRequeueJob('failed'), true)
  })

  it('processing (stuck) → eligible for requeue', () => {
    assert.equal(canRequeueJob('processing'), true)
  })

  it('done → not eligible (returns 422)', () => {
    assert.equal(canRequeueJob('done'), false)
  })

  it('pending → not eligible (already queued, returns 422)', () => {
    assert.equal(canRequeueJob('pending'), false)
  })
})

// ============================================================================
// ADM-07 — Audit log: requestContext IP/UA extraction + audit payload structure
// ============================================================================

// requestContext mirrored inline to avoid importing audit.ts which pulls in the
// Supabase server client (side-effect import). Logic is identical to the source.
function requestContext(req: { headers: { get(key: string): string | null } }): {
  ipAddress: string | null
  userAgent: string | null
} {
  return {
    ipAddress:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      null,
    userAgent: req.headers.get('user-agent') ?? null,
  }
}

function buildAuditPayload(
  action: string,
  actorId: string,
  actorEmail: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
  ipAddress: string | null = null,
  userAgent: string | null = null,
) {
  return {
    actor_id:    actorId,
    actor_email: actorEmail,
    action,
    target_type: targetType,
    target_id:   targetId,
    metadata,
    ip_address:  ipAddress,
    user_agent:  userAgent,
  }
}

describe('ADM-07 requestContext — IP address extraction', () => {
  it('extracts first IP from x-forwarded-for (proxy chain)', () => {
    const req = { headers: { get: (k: string) => k === 'x-forwarded-for' ? '1.2.3.4, 5.6.7.8' : null } }
    assert.equal(requestContext(req).ipAddress, '1.2.3.4')
  })

  it('trims whitespace from extracted x-forwarded-for IP', () => {
    const req = { headers: { get: (k: string) => k === 'x-forwarded-for' ? '  10.0.0.1  , proxy' : null } }
    assert.equal(requestContext(req).ipAddress, '10.0.0.1')
  })

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = { headers: { get: (k: string) => k === 'x-real-ip' ? '9.0.0.1' : null } }
    assert.equal(requestContext(req).ipAddress, '9.0.0.1')
  })

  it('returns null when no IP header is present', () => {
    const req = { headers: { get: () => null } }
    assert.equal(requestContext(req).ipAddress, null)
  })
})

describe('ADM-07 requestContext — user-agent extraction', () => {
  it('extracts user-agent header', () => {
    const req = { headers: { get: (k: string) => k === 'user-agent' ? 'Mozilla/5.0' : null } }
    assert.equal(requestContext(req).userAgent, 'Mozilla/5.0')
  })

  it('returns null when user-agent header absent', () => {
    const req = { headers: { get: () => null } }
    assert.equal(requestContext(req).userAgent, null)
  })
})

describe('ADM-07 buildAuditPayload — field mapping for each admin action', () => {
  it('user.role_change maps actor + target + metadata with role transition', () => {
    const row = buildAuditPayload(
      'user.role_change', 'admin-id', 'admin@example.com',
      'user', 'target-id',
      { previous_role: 'user', new_role: 'admin' },
    )
    assert.equal(row.action, 'user.role_change')
    assert.deepEqual(row.metadata, { previous_role: 'user', new_role: 'admin' })
    assert.equal(row.actor_email, 'admin@example.com')
  })

  it('user.disable includes ban_duration in metadata', () => {
    const row = buildAuditPayload(
      'user.disable', 'admin-id', 'admin@example.com',
      'user', 'target-id',
      { ban_duration: '876600h' },
    )
    assert.equal(row.action, 'user.disable')
    assert.equal(row.metadata.ban_duration, '876600h')
  })

  it('user.delete records the deleted user email in metadata', () => {
    const row = buildAuditPayload(
      'user.delete', 'admin-id', 'admin@example.com',
      'user', 'target-id',
      { deleted_email: 'gone@example.com' },
      '127.0.0.1', 'TestAgent/1.0',
    )
    assert.equal(row.action, 'user.delete')
    assert.equal(row.ip_address, '127.0.0.1')
    assert.equal(row.user_agent, 'TestAgent/1.0')
    assert.equal(row.metadata.deleted_email, 'gone@example.com')
  })

  it('meeting.requeue maps target_type = meeting with previous_status', () => {
    const row = buildAuditPayload(
      'meeting.requeue', 'admin-id', 'admin@example.com',
      'meeting', 'mtg-uuid',
      { previous_status: 'failed', meeting_owner_id: 'owner-uuid' },
    )
    assert.equal(row.target_type, 'meeting')
    assert.equal(row.target_id,   'mtg-uuid')
    assert.deepEqual(row.metadata, { previous_status: 'failed', meeting_owner_id: 'owner-uuid' })
  })

  it('ip_address and user_agent default to null when omitted', () => {
    const row = buildAuditPayload('user.enable', 'a', 'a@b.com', 'user', 'uid')
    assert.equal(row.ip_address, null)
    assert.equal(row.user_agent, null)
  })

  it('actor_email always contains @ (required for incident tracing)', () => {
    const row = buildAuditPayload('user.enable', 'admin-id', 'admin@example.com', 'user', 'uid')
    assert.match(row.actor_email, /@/)
  })

  it('metadata defaults to empty object when omitted', () => {
    const row = buildAuditPayload('user.enable', 'a', 'a@b.com', 'user', 'uid')
    assert.deepEqual(row.metadata, {})
  })
})
