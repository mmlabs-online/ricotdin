// Unit tests for resolveAppVersion — the value served by GET /version.json.
// Runtime RICOTDIN_VERSION wins; the baked BUILD_COMMIT is the fallback;
// 'unknown' when neither is set.
//
// Pure, no I/O. Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAppVersion } from '../lib/release/version.js'

describe('resolveAppVersion', () => {
  it('version set → version (wins over commit)', () => {
    assert.equal(resolveAppVersion({ version: 'v1.2.3', commit: 'abc123' }), 'v1.2.3')
    assert.equal(resolveAppVersion({ version: 'v1.2.3' }), 'v1.2.3')
  })

  it('whitespace-only or empty version → commit', () => {
    assert.equal(resolveAppVersion({ version: '   ', commit: 'abc123' }), 'abc123')
    assert.equal(resolveAppVersion({ version: '', commit: 'abc123' }), 'abc123')
    assert.equal(resolveAppVersion({ commit: 'abc123' }), 'abc123')
  })

  it('both empty or unset → unknown', () => {
    assert.equal(resolveAppVersion({}), 'unknown')
    assert.equal(resolveAppVersion({ version: '', commit: '' }), 'unknown')
    assert.equal(resolveAppVersion({ version: ' ', commit: '\n' }), 'unknown')
  })

  it('trims surrounding whitespace', () => {
    assert.equal(resolveAppVersion({ version: '  v1.2.3\n' }), 'v1.2.3')
    assert.equal(resolveAppVersion({ commit: ' abc123 ' }), 'abc123')
  })
})
