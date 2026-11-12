// Unit tests for lib/auth/validate.ts
// Run with: npm test

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeUsername,
  validateUsername,
  validateEmail,
  validatePassword,
  looksLikeEmail,
} from '../lib/auth/validate.js'

// ---------------------------------------------------------------------------
// normalizeUsername
// ---------------------------------------------------------------------------

describe('normalizeUsername', () => {
  it('lowercases the input', () => {
    assert.equal(normalizeUsername('Alice'), 'alice')
  })

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeUsername('  bob  '), 'bob')
  })

  it('lowercases and trims together', () => {
    assert.equal(normalizeUsername('  CAROL  '), 'carol')
  })
})

// ---------------------------------------------------------------------------
// validateUsername
// ---------------------------------------------------------------------------

describe('validateUsername', () => {
  it('accepts a valid username', () => {
    assert.equal(validateUsername('alice'), null)
  })

  it('accepts minimum length (3 chars)', () => {
    assert.equal(validateUsername('abc'), null)
  })

  it('accepts maximum length (30 chars)', () => {
    assert.equal(validateUsername('a'.repeat(30)), null)
  })

  it('accepts digits', () => {
    assert.equal(validateUsername('user42'), null)
  })

  it('accepts hyphens and underscores', () => {
    assert.equal(validateUsername('my-user_name'), null)
  })

  it('rejects too short (2 chars)', () => {
    assert.notEqual(validateUsername('ab'), null)
  })

  it('rejects empty string', () => {
    assert.notEqual(validateUsername(''), null)
  })

  it('rejects too long (31 chars)', () => {
    assert.notEqual(validateUsername('a'.repeat(31)), null)
  })

  it('rejects uppercase letters', () => {
    assert.notEqual(validateUsername('Alice'), null)
  })

  it('rejects spaces', () => {
    assert.notEqual(validateUsername('my user'), null)
  })

  it('rejects special chars other than hyphen/underscore', () => {
    assert.notEqual(validateUsername('user@name'), null)
    assert.notEqual(validateUsername('user.name'), null)
    assert.notEqual(validateUsername('user!'), null)
  })
})

// ---------------------------------------------------------------------------
// validateEmail
// ---------------------------------------------------------------------------

describe('validateEmail', () => {
  it('accepts a valid email', () => {
    assert.equal(validateEmail('user@example.com'), null)
  })

  it('rejects a string without @', () => {
    assert.notEqual(validateEmail('notanemail'), null)
  })

  it('rejects an empty string', () => {
    assert.notEqual(validateEmail(''), null)
  })
})

// ---------------------------------------------------------------------------
// validatePassword
// ---------------------------------------------------------------------------

describe('validatePassword', () => {
  it('accepts a password of exactly 8 characters', () => {
    assert.equal(validatePassword('12345678'), null)
  })

  it('accepts a longer password', () => {
    assert.equal(validatePassword('correct-horse-battery-staple'), null)
  })

  it('rejects a 7-character password', () => {
    assert.notEqual(validatePassword('short12'), null)
  })

  it('rejects an empty password', () => {
    assert.notEqual(validatePassword(''), null)
  })
})

// ---------------------------------------------------------------------------
// looksLikeEmail
// ---------------------------------------------------------------------------

describe('looksLikeEmail', () => {
  it('returns true for a string containing @', () => {
    assert.equal(looksLikeEmail('user@example.com'), true)
  })

  it('returns false for a plain username', () => {
    assert.equal(looksLikeEmail('alice'), false)
  })

  it('returns false for a username with no @', () => {
    assert.equal(looksLikeEmail('user-name_42'), false)
  })
})
