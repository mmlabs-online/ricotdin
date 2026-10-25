// Pure unit tests for quota reconciliation helpers.
// No I/O, no DB, no mocks — all assertions against deterministic outputs.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeWalletDrift,
  formatReconcileKey,
} from '../lib/quota/reconcileWallets.pure'

// ── computeWalletDrift ────────────────────────────────────────────────────────

describe('computeWalletDrift', () => {
  test('no drift when wallet matches ledger exactly', () => {
    const d = computeWalletDrift(1000, 50, 1000, 50)
    assert.equal(d.hasDrift, false)
    assert.equal(d.audioDrift, 0)
    assert.equal(d.queryDrift, 0)
  })

  test('audio drift: wallet behind ledger (positive audioDrift)', () => {
    // ledger says 1000, wallet cached 900 — wallet is 100 short
    const d = computeWalletDrift(900, 50, 1000, 50)
    assert.equal(d.hasDrift, true)
    assert.equal(d.audioDrift, 100)
    assert.equal(d.queryDrift, 0)
  })

  test('query drift: wallet behind ledger (positive queryDrift)', () => {
    const d = computeWalletDrift(1000, 40, 1000, 50)
    assert.equal(d.hasDrift, true)
    assert.equal(d.audioDrift, 0)
    assert.equal(d.queryDrift, 10)
  })

  test('both axes drifted simultaneously', () => {
    const d = computeWalletDrift(800, 30, 1000, 50)
    assert.equal(d.hasDrift, true)
    assert.equal(d.audioDrift, 200)
    assert.equal(d.queryDrift, 20)
  })

  test('negative drift: wallet over-reported relative to ledger', () => {
    // Should not happen in normal operation, but the function handles it
    const d = computeWalletDrift(1100, 50, 1000, 50)
    assert.equal(d.hasDrift, true)
    assert.equal(d.audioDrift, -100)
    assert.equal(d.queryDrift, 0)
  })

  test('all zeros — no drift', () => {
    const d = computeWalletDrift(0, 0, 0, 0)
    assert.equal(d.hasDrift, false)
    assert.equal(d.audioDrift, 0)
    assert.equal(d.queryDrift, 0)
  })

  test('large values are handled without precision loss', () => {
    const d = computeWalletDrift(9_000_000, 0, 9_000_001, 0)
    assert.equal(d.hasDrift, true)
    assert.equal(d.audioDrift, 1)
  })

  test('negative balance (overdraw) detected as drift relative to ledger', () => {
    // Wallet went negative after an overdraw settle; ledger sum matches
    const d = computeWalletDrift(-5, 0, -5, 0)
    assert.equal(d.hasDrift, false)
    assert.equal(d.audioDrift, 0)
  })
})

// ── formatReconcileKey ────────────────────────────────────────────────────────

describe('formatReconcileKey', () => {
  test('formats correctly', () => {
    const key = formatReconcileKey('user-abc', 'run-xyz')
    assert.equal(key, 'reconcile:user-abc:run-xyz')
  })

  test('handles UUID values', () => {
    const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const runId = '00000000-0000-0000-0000-000000000001'
    assert.equal(formatReconcileKey(userId, runId), `reconcile:${userId}:${runId}`)
  })

  test('two calls with same args produce identical keys', () => {
    const k1 = formatReconcileKey('u', 'r')
    const k2 = formatReconcileKey('u', 'r')
    assert.equal(k1, k2)
  })

  test('different runId produces different key', () => {
    const k1 = formatReconcileKey('same-user', 'run-1')
    const k2 = formatReconcileKey('same-user', 'run-2')
    assert.notEqual(k1, k2)
  })

  test('different userId produces different key', () => {
    const k1 = formatReconcileKey('user-A', 'same-run')
    const k2 = formatReconcileKey('user-B', 'same-run')
    assert.notEqual(k1, k2)
  })

  test('key starts with reconcile: prefix', () => {
    const key = formatReconcileKey('u', 'r')
    assert.ok(key.startsWith('reconcile:'), `key should start with 'reconcile:', got: ${key}`)
  })
})
