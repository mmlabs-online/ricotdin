// Unit tests for errorToMessage — the log serializer that avoids "[object Object]".
// All pure — no I/O.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { errorToMessage, describeError } from '../lib/logger.js'

describe('errorToMessage', () => {
  it('returns .message for Error instances', () => {
    assert.equal(errorToMessage(new Error('boom')), 'boom')
  })

  it('returns strings as-is', () => {
    assert.equal(errorToMessage('plain string'), 'plain string')
  })

  it('formats a Supabase PostgrestError object (message + code + details)', () => {
    const pgErr = { message: 'deadlock detected', code: '40P01', details: 'process 123 waits', hint: null }
    assert.equal(errorToMessage(pgErr), 'deadlock detected (40P01) — process 123 waits')
  })

  it('formats a plain object with only a message', () => {
    assert.equal(errorToMessage({ message: 'just a message' }), 'just a message')
  })

  it('JSON-stringifies an object with no message field (never "[object Object]")', () => {
    const result = errorToMessage({ foo: 'bar', n: 1 })
    assert.notEqual(result, '[object Object]')
    assert.equal(result, '{"foo":"bar","n":1}')
  })

  it('handles null and undefined', () => {
    assert.equal(errorToMessage(null), 'null')
    assert.equal(errorToMessage(undefined), 'undefined')
  })

  it('circular object never returns bare "[object Object]" — shows shape', () => {
    const circular: Record<string, unknown> = { code: 500, foo: 'bar' }
    circular.self = circular
    const result = errorToMessage(circular)
    assert.notEqual(result, '[object Object]')
    assert.match(result, /\{.*code.*\}/) // lists its keys
  })
})

describe('describeError', () => {
  it('includes the error name and message', () => {
    const out = describeError(new TypeError('bad thing'))
    assert.match(out, /^TypeError: bad thing/)
  })

  it('surfaces Postgres/PostgREST fields (code, hint, details)', () => {
    const pgErr = Object.assign(new Error('permission denied'), {
      code: '42501', hint: 'GRANT SELECT ...', details: 'on table x',
    })
    pgErr.name = 'PostgrestError'
    const out = describeError(pgErr)
    assert.match(out, /PostgrestError: permission denied/)
    assert.match(out, /42501/)
    assert.match(out, /GRANT SELECT/)
  })

  it('appends the originating stack frame (@ file/fn)', () => {
    function throwHere() { throw new Error('boom') }
    try { throwHere() } catch (e) {
      const out = describeError(e)
      assert.match(out, /boom/)
      assert.match(out, /@ /) // has an origin frame
    }
  })

  it('for new Error(object) — message is "[object Object]" but frame still pinpoints it', () => {
    // Reproduces the exact failure mode: an Error built from an object.
    const bad = new Error({ a: 1 } as unknown as string)
    const out = describeError(bad)
    assert.match(out, /Error: \[object Object\]/)
    assert.match(out, /@ /) // the stack frame is what saves us
  })

  it('falls back to errorToMessage for non-Error values', () => {
    assert.equal(describeError('plain'), 'plain')
    assert.equal(describeError({ message: 'obj msg' }), 'obj msg')
  })
})
