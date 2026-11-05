import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import {
  adminErrorKey,
  bulkSummary,
  grantAmount,
  grantProblem,
  BULK_MAX,
  healthSummary,
  ledgerReasonKey,
  monthValue,
  userActions,
  type AdminUser,
} from './users'

const u = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: 'u1',
  email: 'a@b.c',
  username: 'alex',
  role: 'user',
  disabled: false,
  email_confirmed: true,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  last_sign_in_at: null,
  ...over,
})

describe('userActions', () => {
  it('nothing that touches yourself (API 400 anyway)', () => {
    expect(userActions(u({ id: 'me', role: 'admin' }), 'me')).toEqual({
      changeRole: false, disable: false, enable: false, delete: false, resetPassword: true, promote: false,
    })
  })
  it('an active user can be promoted, disabled, deleted', () => {
    expect(userActions(u(), 'me')).toMatchObject({ changeRole: true, disable: true, enable: false, delete: true, promote: true })
  })
  it('only an active, verified account can become admin (§0.9)', () => {
    expect(userActions(u({ status: 'unverified', email_confirmed: false }), 'me').promote).toBe(false)
    expect(userActions(u({ status: 'disabled', disabled: true }), 'me')).toMatchObject({ promote: false, disable: false, enable: true })
  })
  it('an admin can be demoted (promote is about making admins)', () => {
    expect(userActions(u({ role: 'admin' }), 'me')).toMatchObject({ changeRole: true, promote: false })
  })
})

describe('grantProblem', () => {
  it('checks the grant like the API', () => {
    expect(grantProblem('', '')).toBe('admin.quota.errors.empty')
    expect(grantProblem('0', '0')).toBe('admin.quota.errors.empty')
    expect(grantProblem('0.001', '')).toBe('admin.quota.errors.empty') // rounds to 0 s
    expect(grantProblem('-5', '')).toBe('admin.quota.errors.negative')
    expect(grantProblem('abc', '')).toBe('admin.quota.errors.number')
    expect(grantProblem('', '1.5')).toBe('admin.quota.errors.whole')
    expect(grantProblem('100001', '')).toBe('admin.quota.errors.tooLarge')
    expect(grantProblem('', '1000001')).toBe('admin.quota.errors.tooLarge')
    expect(grantProblem('60', '')).toBeNull()
    expect(grantProblem('', '10')).toBeNull()
    expect(grantProblem('1,5', '')).toBeNull() // Vietnamese decimal comma
    expect(grantAmount('1,5')).toBe(1.5)
    expect(grantAmount(' ')).toBeUndefined()
  })
})

describe('adminErrorKey', () => {
  const e = (status: number, code = 'x') => new ApiError(status, code, '')
  it('maps statuses', () => {
    expect(adminErrorKey(e(400))).toBe('admin.errors.refused')
    expect(adminErrorKey(e(404))).toBe('admin.errors.notFound')
    expect(adminErrorKey(e(403))).toBe('admin.errors.forbidden')
    expect(adminErrorKey(e(429))).toBe('admin.errors.rateLimited')
    expect(adminErrorKey(e(503))).toBe('admin.errors.unavailable')
    expect(adminErrorKey(e(0, 'network'))).toBe('admin.errors.network')
    expect(adminErrorKey(e(500))).toBe('admin.errors.generic')
    expect(adminErrorKey(new Error('x'))).toBe('admin.errors.generic')
  })
})

describe('bulkSummary', () => {
  it('counts what happened', () => {
    expect(bulkSummary({ processed: 3 })).toEqual({ processed: 3, failed: 0, skippedSelf: false })
    expect(bulkSummary({ processed: 1, errors: [{ id: 'x' }, { id: 'y' }], skippedSelf: ['me'] })).toEqual({ processed: 1, failed: 2, skippedSelf: true })
    expect(bulkSummary(null)).toEqual({ processed: 0, failed: 0, skippedSelf: false })
  })
})

describe('ledgerReasonKey', () => {
  it('known reasons, else other', () => {
    expect(ledgerReasonKey('admin_grant')).toBe('admin.quota.reason.admin_grant')
    expect(ledgerReasonKey('generate')).toBe('admin.quota.reason.generate')
    expect(ledgerReasonKey('weird')).toBe('admin.quota.reason.other')
  })
})

describe('monthValue', () => {
  it('YYYY-MM of a date (UTC), and validates input', () => {
    expect(monthValue(new Date('2026-11-05T01:00:00Z'))).toBe('2026-11')
    expect(monthValue('2026-02')).toBe('2026-02')
    expect(monthValue('2026-13')).toBeNull()
    expect(monthValue('x')).toBeNull()
    expect(monthValue('1969-12')).toBeNull() // the API answers the current month outside 1970–2100
    expect(monthValue('2101-01')).toBeNull()
  })
})

describe('healthSummary', () => {
  it('reads the report, unknown when malformed', () => {
    expect(healthSummary({ status: 'ok', checks: { database: { status: 'ok' } } })).toEqual({ status: 'ok', checks: [{ name: 'database', status: 'ok' }] })
    expect(healthSummary({ status: 'degraded', checks: { drive: { status: 'error', message: 'x' }, worker: { status: 'warning' } } })).toEqual({
      status: 'degraded', checks: [{ name: 'drive', status: 'error' }, { name: 'worker', status: 'warning' }],
    })
    expect(healthSummary(null)).toEqual({ status: 'unknown', checks: [] })
    // provider key checks are named `keys:<config key>` by the API
    expect(healthSummary({ status: 'ok', checks: { 'keys:gemini_api_key': { status: 'ok' }, 'keys:speechmatics_api_key': { status: 'warning' } } }).checks).toEqual([
      { name: 'gemini', status: 'ok' },
      { name: 'speechmatics', status: 'warning' },
    ])
    expect(healthSummary({ checks: { 'a:b.c': { status: 'ok' } } }).checks[0]?.name).toBe('other')
    expect(healthSummary({ status: 5, checks: { a: { status: 'odd' } } })).toEqual({ status: 'unknown', checks: [{ name: 'a', status: 'unknown' }] })
  })
})

describe('BULK_MAX', () => {
  it('matches the API cap (BULK_MAX_IDS)', () => {
    expect(BULK_MAX).toBe(50)
  })
})
