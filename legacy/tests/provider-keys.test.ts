// Unit tests for SEC-04 provider key management — all pure, no I/O.
// Tests cover the crypto helpers and the admin_config guard functions.
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { encryptSecretWithKey, decryptSecretWithKey } from '../lib/crypto/index.js'
import { isLastActiveKey, maskAdminConfig } from '../lib/keys/index.js'
import type { AdminConfigRow } from '../types/database.js'

const TEST_KEY = randomBytes(32)

// ── Crypto round-trip ─────────────────────────────────────────────────────────

describe('encryptSecretWithKey / decryptSecretWithKey', () => {
  it('round-trips an API key', () => {
    const plaintext = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345678'
    const encrypted = encryptSecretWithKey(plaintext, TEST_KEY)
    assert.equal(decryptSecretWithKey(encrypted, TEST_KEY), plaintext)
  })

  it('produces different ciphertext each call (random IV)', () => {
    const plaintext = 'same-key'
    const a = encryptSecretWithKey(plaintext, TEST_KEY)
    const b = encryptSecretWithKey(plaintext, TEST_KEY)
    assert.notEqual(a.ciphertext, b.ciphertext)
    assert.notEqual(a.iv, b.iv)
  })

  it('throws on tampered ciphertext', () => {
    const enc = encryptSecretWithKey('secret', TEST_KEY)
    assert.throws(() =>
      decryptSecretWithKey(
        { ...enc, ciphertext: Buffer.from('bad-data').toString('base64') },
        TEST_KEY,
      ),
    )
  })

  it('throws on tampered auth tag', () => {
    const enc = encryptSecretWithKey('secret', TEST_KEY)
    assert.throws(() =>
      decryptSecretWithKey(
        { ...enc, authTag: Buffer.alloc(16, 0xff).toString('base64') },
        TEST_KEY,
      ),
    )
  })

  it('throws when decrypting with the wrong key', () => {
    const enc = encryptSecretWithKey('secret', TEST_KEY)
    assert.throws(() => decryptSecretWithKey(enc, randomBytes(32)))
  })

  it('throws when encryption key is not 32 bytes', () => {
    assert.throws(() => encryptSecretWithKey('x', randomBytes(16)))
    assert.throws(() => encryptSecretWithKey('x', randomBytes(64)))
  })
})

// ── isLastActiveKey guard ─────────────────────────────────────────────────────

describe('isLastActiveKey', () => {
  it('returns true for 1 active key (would be the last)', () => {
    assert.equal(isLastActiveKey(1), true)
  })
  it('returns true for 0 active keys (edge: already empty)', () => {
    assert.equal(isLastActiveKey(0), true)
  })
  it('returns false for 2 active keys', () => {
    assert.equal(isLastActiveKey(2), false)
  })
  it('returns false for many active keys', () => {
    assert.equal(isLastActiveKey(10), false)
  })
})

// ── maskAdminConfig security invariant ───────────────────────────────────────

describe('maskAdminConfig', () => {
  const row: AdminConfigRow = {
    id: 'entry-id-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    config_key: 'gemini_api_key',
    label: 'prod-key-1',
    value_ciphertext: 'SENSITIVE_CIPHERTEXT_DO_NOT_EXPOSE',
    value_iv: 'SENSITIVE_IV_DO_NOT_EXPOSE',
    value_auth_tag: 'SENSITIVE_TAG_DO_NOT_EXPOSE',
    last4: 'wxyz',
    status: 'active',
    disabled_reason: null,
    last_used_at: null,
    created_by: 'admin-uuid-do-not-expose',
    health_status: 'healthy',
    health_checked_at: '2024-01-02T00:00:00Z',
    health_detail: 'OK (200)',
  }

  it('never exposes value_ciphertext', () => {
    assert.equal('value_ciphertext' in maskAdminConfig(row), false)
  })

  it('never exposes value_iv', () => {
    assert.equal('value_iv' in maskAdminConfig(row), false)
  })

  it('never exposes value_auth_tag', () => {
    assert.equal('value_auth_tag' in maskAdminConfig(row), false)
  })

  it('never exposes created_by', () => {
    assert.equal('created_by' in maskAdminConfig(row), false)
  })

  it('exposes safe display fields', () => {
    const masked = maskAdminConfig(row)
    assert.equal(masked.id, 'entry-id-1')
    assert.equal(masked.config_key, 'gemini_api_key')
    assert.equal(masked.label, 'prod-key-1')
    assert.equal(masked.last4, 'wxyz')
    assert.equal(masked.status, 'active')
    assert.equal(masked.disabled_reason, null)
    assert.equal(masked.last_used_at, null)
  })

  it('JSON serialization does not contain any sensitive strings', () => {
    const json = JSON.stringify(maskAdminConfig(row))
    assert.equal(json.includes('SENSITIVE_CIPHERTEXT'), false)
    assert.equal(json.includes('SENSITIVE_IV'), false)
    assert.equal(json.includes('SENSITIVE_TAG'), false)
    assert.equal(json.includes('admin-uuid-do-not-expose'), false)
  })
})
