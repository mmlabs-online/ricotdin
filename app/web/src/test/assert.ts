// The node:assert subset used by tests ported from legacy/tests (ARC-12), on top of vitest's expect.
import { expect } from 'vitest'

const assert = {
  equal<T>(actual: T, expected: T, message?: string): void {
    expect(actual, message).toBe(expected)
  },
  ok(value: unknown, message?: string): void {
    expect(Boolean(value), message).toBe(true)
  },
  match(value: string, pattern: RegExp, message?: string): void {
    expect(value, message).toMatch(pattern)
  },
  deepEqual<T>(actual: T, expected: T, message?: string): void {
    expect(actual, message).toEqual(expected)
  },
}
export default assert
