import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMeetingIds, validateChatScope, classifyChatOutcome } from '../lib/rag/scope'

describe('deriveMeetingIds', () => {
  it('single meeting → one-element array', () => {
    assert.deepStrictEqual(deriveMeetingIds('abc', null), ['abc'])
  })

  it('folder meeting set → passes through', () => {
    assert.deepStrictEqual(deriveMeetingIds(null, ['a', 'b']), ['a', 'b'])
  })

  it('empty folder meeting set → passes through as []', () => {
    assert.deepStrictEqual(deriveMeetingIds(null, []), [])
  })

  it('both null → global scope (null)', () => {
    assert.strictEqual(deriveMeetingIds(null, null), null)
  })

  it('meetingId set with folderMeetingIds → meetingId wins (defensive)', () => {
    assert.deepStrictEqual(deriveMeetingIds('m1', ['a', 'b']), ['m1'])
  })

  it('meetingId empty string treated as falsy → uses folderMeetingIds', () => {
    assert.deepStrictEqual(deriveMeetingIds('', ['x']), ['x'])
  })
})

describe('validateChatScope', () => {
  it('neither set → valid', () => {
    assert.strictEqual(validateChatScope(null, null), null)
  })

  it('meetingId only → valid', () => {
    assert.strictEqual(validateChatScope('m1', null), null)
  })

  it('folderId only → valid', () => {
    assert.strictEqual(validateChatScope(null, 'f1'), null)
  })

  it('both set → returns error string', () => {
    const err = validateChatScope('m1', 'f1')
    assert.ok(typeof err === 'string' && err.length > 0)
  })
})

describe('classifyChatOutcome', () => {
  it('retrieval threw → retrieval_error (regardless of chunk count)', () => {
    assert.strictEqual(classifyChatOutcome(true, 0), 'retrieval_error')
    assert.strictEqual(classifyChatOutcome(true, 5), 'retrieval_error')
  })

  it('retrieval OK but zero chunks → no_context', () => {
    assert.strictEqual(classifyChatOutcome(false, 0), 'no_context')
  })

  it('retrieval OK with chunks → answer', () => {
    assert.strictEqual(classifyChatOutcome(false, 1), 'answer')
    assert.strictEqual(classifyChatOutcome(false, 8), 'answer')
  })

  it('a technical failure is NEVER reported as no_context (the masking bug)', () => {
    // Even though chunkCount is 0 after a failure, the outcome must be the
    // technical-error branch, not the "no relevant information" branch.
    assert.notStrictEqual(classifyChatOutcome(true, 0), 'no_context')
  })
})

describe('scope derivation — integration', () => {
  it('meeting scope: single meeting retrieval filter', () => {
    const ids = deriveMeetingIds('meeting-123', null)
    assert.deepStrictEqual(ids, ['meeting-123'])
  })

  it('folder scope: multi-meeting retrieval filter', () => {
    const folderMeetings = ['m1', 'm2', 'm3']
    const ids = deriveMeetingIds(null, folderMeetings)
    assert.deepStrictEqual(ids, folderMeetings)
  })

  it('global scope: no filter', () => {
    assert.strictEqual(deriveMeetingIds(null, null), null)
  })

  it('folder scope with empty folder: empty filter (no chunks retrieved)', () => {
    const ids = deriveMeetingIds(null, [])
    assert.deepStrictEqual(ids, [])
  })

  it('actor-pays: scope identity does not affect which userId is charged (pure assertion)', () => {
    // Quota is charged to the caller's userId regardless of scope.
    // This test documents the invariant: deriveMeetingIds has no userId argument.
    const ids = deriveMeetingIds('some-meeting', null)
    assert.ok(Array.isArray(ids))
  })
})
