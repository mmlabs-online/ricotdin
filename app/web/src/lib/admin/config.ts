// Admin configuration screens (ARC-14c: keys, config, models, features). Pure. The API decides
// every rule (app/domain/admin_config.py); these mirror it so the admin learns before sending.

import { ApiError } from '../../api/errors'
import { adminErrorKey } from './users'

/** Errors on the configuration screens: the API's 400/422 means the value was refused, 409 a
 * duplicate (feature key); everything else as on the other admin screens. */
export function configErrorKey(err: unknown): string {
  if (err instanceof ApiError && (err.status === 400 || err.status === 422)) return 'admin.errors.invalid'
  if (err instanceof ApiError && err.status === 409) return 'admin.errors.duplicate'
  return adminErrorKey(err)
}

// --- provider keys -------------------------------------------------------------------------------

/** catalog providers + Speechmatics, in display order (config key = `<provider>_api_key`) */
export const KEY_PROVIDERS = ['gemini', 'openai', 'grok', 'speechmatics'] as const
export type KeyProvider = (typeof KEY_PROVIDERS)[number]

export function providerOfKey(configKey: string): KeyProvider | null {
  const p = configKey.replace(/_api_key$/, '')
  return configKey.endsWith('_api_key') && (KEY_PROVIDERS as readonly string[]).includes(p) ? (p as KeyProvider) : null
}

export function keyProblem(v: { label: string; key: string }): string | null {
  const label = v.label.trim()
  const key = v.key.trim()
  if (!label) return 'admin.keys.errors.label'
  if (label.length > 80) return 'admin.keys.errors.labelLong'
  if (key.length < 8) return 'admin.keys.errors.keyShort'
  if (key.length > 512) return 'admin.keys.errors.keyLong'
  if (!/^[\x21-\x7e]+$/.test(key)) return 'admin.keys.errors.keyChars' // the key travels in an HTTP header
  return null
}

export function healthStatusKind(status: string | null): 'success' | 'danger' | 'processing' {
  return status === 'healthy' ? 'success' : status === 'unhealthy' ? 'danger' : 'processing'
}

// --- app config ----------------------------------------------------------------------------------

export type ConfigKind = 'retention' | 'flag' | 'bool' | 'number' | 'string' | 'readonly'

export function configKind(key: string, value: unknown): ConfigKind {
  if (key === 'storage.audio_retention_days') return 'retention'
  if (key === 'user_hack_audio_render') return 'flag'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'readonly'
}

export function parseConfigInput(kind: 'retention' | 'number' | 'string', raw: string): { value: number | string | null } | { error: string } {
  const v = raw.trim()
  if (kind === 'retention') {
    if (v === '') return { value: null } // keep audio forever
    return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 3650 ? { value: Number(v) } : { error: 'admin.config.errors.retention' }
  }
  if (kind === 'number') {
    const n = Number(v)
    return v !== '' && Number.isFinite(n) ? { value: n } : { error: 'admin.config.errors.number' }
  }
  return raw.length > 2000 ? { error: 'admin.config.errors.tooLong' } : { value: raw }
}

// --- generation models ---------------------------------------------------------------------------

export interface ModelPick {
  provider: string
  model: string
}
export const sameModel = (a: ModelPick, b: ModelPick) => a.provider === b.provider && a.model === b.model

export function generationProblem(allowed: readonly ModelPick[], systemDefault: ModelPick): string | null {
  if (allowed.length === 0) return 'admin.models.errors.empty'
  return allowed.some((m) => sameModel(m, systemDefault)) ? null : 'admin.models.errors.default'
}

// --- features ------------------------------------------------------------------------------------

export const FEATURE_ARRAYS = ['note_tags', 'depends_on', 'blocks', 'key_files'] as const
export const FEATURE_TEXTS = ['title', 'description', 'content', 'change_note'] as const

export interface FeatureFields {
  title: string
  description: string | null
  content: string | null
  status: string
  priority: string | null
  note_tags: string[]
  depends_on: string[]
  blocks: string[]
  key_files: string[]
  change_note: string | null
}

export const listText = (items: readonly string[]) => items.join('\n')

/** One item per line, trimmed, no blanks or repeats, ≤ 100 items of ≤ 300 chars (the API caps). */
export function parseList(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const item = line.trim().slice(0, 300)
    if (item && !out.includes(item)) out.push(item)
    if (out.length === 100) break
  }
  return out
}

/** Only the fields that changed (PATCH); an emptied text field becomes null. */
export function featureChanges(original: FeatureFields, draft: FeatureFields): Partial<FeatureFields> {
  const out: Record<string, unknown> = {}
  for (const k of FEATURE_TEXTS) {
    const before = original[k] ?? ''
    const after = draft[k] ?? ''
    if (before !== after) out[k] = k === 'title' ? after : after === '' ? null : after
  }
  if (original.status !== draft.status) out.status = draft.status
  if ((original.priority ?? null) !== (draft.priority ?? null)) out.priority = draft.priority
  for (const k of FEATURE_ARRAYS) {
    if (original[k].join('\n') !== draft[k].join('\n')) out[k] = draft[k]
  }
  return out as Partial<FeatureFields>
}

export function featureCreateProblem(v: { key: string; module_prefix: string; module_name: string; title: string }): string | null {
  if (!v.key.trim() || !v.module_prefix.trim() || !v.module_name.trim() || !v.title.trim()) return 'admin.features.errors.required'
  if (!/^[A-Z][A-Z0-9]{0,9}-[A-Z0-9]{1,10}$/.test(v.key.trim().toUpperCase())) return 'admin.features.errors.key'
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(v.module_prefix.trim().toUpperCase())) return 'admin.features.errors.prefix'
  return null
}
