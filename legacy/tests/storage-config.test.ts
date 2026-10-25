// Unit tests for storage-config pure helpers (R2 admin config).
// All pure — no I/O, no live storage calls.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { maskStorageRow, STORAGE_SAFE_SELECT } from '../lib/storage/config.js'

describe('maskStorageRow', () => {
  const raw = {
    id: 'abc', created_at: 't1', updated_at: 't2', provider: 'r2', label: 'prod',
    account_id: 'acct123', access_key_id: 'AKID', bucket: 'recordings',
    secret_ciphertext: 'CIPHER', secret_iv: 'IV', secret_auth_tag: 'TAG', secret_last4: 'wxyz',
    status: 'active' as const, disabled_reason: null, last_used_at: null, created_by: 'user1',
  }

  it('never exposes ciphertext / iv / auth_tag / created_by', () => {
    const masked = maskStorageRow(raw)
    const json = JSON.stringify(masked)
    assert.ok(!json.includes('CIPHER'))
    assert.ok(!json.includes('IV'))
    assert.ok(!json.includes('TAG'))
    assert.ok(!('secret_ciphertext' in masked))
    assert.ok(!('secret_iv' in masked))
    assert.ok(!('secret_auth_tag' in masked))
    assert.ok(!('created_by' in masked))
  })

  it('keeps the safe display fields including last4', () => {
    const masked = maskStorageRow(raw)
    assert.equal(masked.label, 'prod')
    assert.equal(masked.bucket, 'recordings')
    assert.equal(masked.account_id, 'acct123')
    assert.equal(masked.access_key_id, 'AKID')
    assert.equal(masked.secret_last4, 'wxyz')
    assert.equal(masked.status, 'active')
  })

  it('STORAGE_SAFE_SELECT excludes the ciphertext columns', () => {
    assert.ok(!STORAGE_SAFE_SELECT.includes('ciphertext'))
    assert.ok(!STORAGE_SAFE_SELECT.includes('secret_iv'))
    assert.ok(!STORAGE_SAFE_SELECT.includes('auth_tag'))
    assert.ok(STORAGE_SAFE_SELECT.includes('secret_last4'))
    assert.ok(STORAGE_SAFE_SELECT.includes('bucket'))
  })
})
