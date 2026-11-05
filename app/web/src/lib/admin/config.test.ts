import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import {
  KEY_PROVIDERS,
  configErrorKey,
  configKind,
  featureChanges,
  featureCreateProblem,
  generationProblem,
  healthStatusKind,
  keyProblem,
  listText,
  parseConfigInput,
  parseList,
  providerOfKey,
} from './config'

describe('provider keys', () => {
  it('config keys map to providers in a fixed order', () => {
    expect(KEY_PROVIDERS).toEqual(['gemini', 'openai', 'grok', 'speechmatics'])
    expect(providerOfKey('speechmatics_api_key')).toBe('speechmatics')
    expect(providerOfKey('gemini_api_key')).toBe('gemini')
    expect(providerOfKey('other')).toBeNull()
  })

  it('checks a new key like the API (label 1–80, key 8–512 visible ASCII)', () => {
    const ok = { label: 'Production', key: 'AIzaSyA-1234567890' }
    expect(keyProblem(ok)).toBeNull()
    expect(keyProblem({ ...ok, label: '  ' })).toBe('admin.keys.errors.label')
    expect(keyProblem({ ...ok, label: 'x'.repeat(81) })).toBe('admin.keys.errors.labelLong')
    expect(keyProblem({ ...ok, key: 'short' })).toBe('admin.keys.errors.keyShort')
    expect(keyProblem({ ...ok, key: 'k'.repeat(513) })).toBe('admin.keys.errors.keyLong')
    expect(keyProblem({ ...ok, key: 'has space 123' })).toBe('admin.keys.errors.keyChars')
    expect(keyProblem({ ...ok, key: 'ключ12345678' })).toBe('admin.keys.errors.keyChars')
    expect(keyProblem({ ...ok, key: '  AIzaSyA-1234567890  ' })).toBeNull() // trimmed like the API
  })

  it('health status → badge kind', () => {
    expect(healthStatusKind('healthy')).toBe('success')
    expect(healthStatusKind('unhealthy')).toBe('danger')
    expect(healthStatusKind('unknown')).toBe('processing')
    expect(healthStatusKind(null)).toBe('processing')
  })
})

describe('app config', () => {
  it('known keys get their own editor; others follow the stored value', () => {
    expect(configKind('storage.audio_retention_days', null)).toBe('retention')
    expect(configKind('user_hack_audio_render', false)).toBe('flag')
    expect(configKind('x', true)).toBe('bool')
    expect(configKind('x', 3)).toBe('number')
    expect(configKind('x', 'a')).toBe('string')
    expect(configKind('x', null)).toBe('readonly')
    expect(configKind('x', { a: 1 })).toBe('readonly')
  })

  it('reads what the admin typed (the API rules)', () => {
    expect(parseConfigInput('retention', '')).toEqual({ value: null })
    expect(parseConfigInput('retention', ' 30 ')).toEqual({ value: 30 })
    expect(parseConfigInput('retention', '0')).toEqual({ error: 'admin.config.errors.retention' })
    expect(parseConfigInput('retention', '3651')).toEqual({ error: 'admin.config.errors.retention' })
    expect(parseConfigInput('retention', '1.5')).toEqual({ error: 'admin.config.errors.retention' })
    expect(parseConfigInput('number', '2.5')).toEqual({ value: 2.5 })
    expect(parseConfigInput('number', 'x')).toEqual({ error: 'admin.config.errors.number' })
    expect(parseConfigInput('number', '')).toEqual({ error: 'admin.config.errors.number' })
    expect(parseConfigInput('string', 'hi')).toEqual({ value: 'hi' })
    expect(parseConfigInput('string', 'x'.repeat(2001))).toEqual({ error: 'admin.config.errors.tooLong' })
  })
})

describe('generation config', () => {
  const a = { provider: 'gemini', model: 'gemini-2.5-flash' }
  const b = { provider: 'openai', model: 'gpt-4o' }
  it('needs at least one model and a default from the list', () => {
    expect(generationProblem([a, b], a)).toBeNull()
    expect(generationProblem([], a)).toBe('admin.models.errors.empty')
    expect(generationProblem([b], a)).toBe('admin.models.errors.default')
  })
})

describe('features', () => {
  it('list fields are edited as one item per line', () => {
    expect(listText(['a', 'b'])).toBe('a\nb')
    expect(parseList(' a \n\nb\na\n' + 'c'.repeat(400))).toEqual(['a', 'b', 'c'.repeat(300)])
    expect(parseList('x\n'.repeat(150))).toEqual(['x'])
    expect(parseList(Array.from({ length: 150 }, (_, i) => `k${i}`).join('\n'))).toHaveLength(100)
  })

  it('sends only what changed', () => {
    const f = { title: 'T', description: null, content: 'c', status: 'done', priority: null, note_tags: ['x'], depends_on: [], blocks: [], key_files: [], change_note: null }
    expect(featureChanges(f, { ...f })).toEqual({})
    expect(featureChanges(f, { ...f, title: 'U', note_tags: ['x', 'y'] })).toEqual({ title: 'U', note_tags: ['x', 'y'] })
    expect(featureChanges(f, { ...f, description: '' })).toEqual({}) // empty = still nothing
    expect(featureChanges(f, { ...f, content: '' })).toEqual({ content: null })
  })

  it('a new feature needs a PREFIX-ID key, a prefix, a module name and a title', () => {
    const ok = { key: 'ARC-20', module_prefix: 'ARC', module_name: 'Architecture', title: 'X' }
    expect(featureCreateProblem(ok)).toBeNull()
    expect(featureCreateProblem({ ...ok, key: 'arc-20' })).toBeNull() // upper-cased like the API
    expect(featureCreateProblem({ ...ok, key: 'ARC20' })).toBe('admin.features.errors.key')
    expect(featureCreateProblem({ ...ok, module_prefix: 'A-B' })).toBe('admin.features.errors.prefix')
    expect(featureCreateProblem({ ...ok, title: ' ' })).toBe('admin.features.errors.required')
  })
})

describe('configErrorKey', () => {
  const e = (status: number) => new ApiError(status, 'x', '')
  it('a refused value is "check the value", a taken feature key a duplicate; the rest as everywhere', () => {
    expect(configErrorKey(e(400))).toBe('admin.errors.invalid')
    expect(configErrorKey(e(422))).toBe('admin.errors.invalid')
    expect(configErrorKey(e(409))).toBe('admin.errors.duplicate')
    expect(configErrorKey(e(403))).toBe('admin.errors.forbidden')
    expect(configErrorKey(e(0))).toBe('admin.errors.network')
  })
})
