// GET  /api/admin/keys     — list all config entries (masked, never ciphertext)
// POST /api/admin/keys     — add a new entry (encrypt + store, return masked record)
//
// Entries are stored in the admin_config table, keyed by config_key.
// Supported config keys: 'gemini_api_key', 'speechmatics_api_key'.
//
// SECURITY:
// - Both endpoints require admin role.
// - value_ciphertext, value_iv, value_auth_tag are NEVER returned.
// - POST receives the plaintext key once, encrypts it, never echoes it back.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { encryptSecret } from '@/lib/crypto'
import { invalidateKeyCache } from '@/lib/keys/provider'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import { logger } from '@/lib/logger'

const ALLOWED_CONFIG_KEYS = ['gemini_api_key', 'speechmatics_api_key', 'openai_api_key', 'grok_api_key'] as const
type AllowedConfigKey = typeof ALLOWED_CONFIG_KEYS[number]

// Provider shorthand derived from configKey, used as the cache invalidation key.
const CONFIG_KEY_TO_PROVIDER: Record<string, string> = {
  gemini_api_key:       'gemini',
  speechmatics_api_key: 'speechmatics',
  openai_api_key:       'openai',
  grok_api_key:         'grok',
}

// Columns safe to return — never include value_ciphertext, value_iv, value_auth_tag.
// Keep each as a single string literal so supabase-js can infer the row type.
// FULL_SELECT includes the migration-029 health columns; BASE_SELECT is the
// pre-029 fallback used when those columns don't exist yet (migration not applied).
const FULL_SELECT =
  'id, created_at, updated_at, config_key, label, last4, status, disabled_reason, last_used_at, health_status, health_checked_at, health_detail'
const BASE_SELECT =
  'id, created_at, updated_at, config_key, label, last4, status, disabled_reason, last_used_at'

export async function GET(req: NextRequest) {
  let caller: { id: string; email?: string }
  try { caller = await requireAdmin(req) } catch (res) { return res as NextResponse }
  void caller

  const db = createServerClient()
  const { data, error } = await db
    .from('admin_config')
    .select(FULL_SELECT)
    .in('config_key', ALLOWED_CONFIG_KEYS)
    .order('config_key', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    // Most likely the health columns don't exist yet (migration 029 not applied).
    // Fall back to the base columns so the keys page keeps working regardless.
    logger.error('[admin/keys] list with health columns failed — retrying without them', {
      detail: error.message,
    })
    const { data: baseData, error: baseError } = await db
      .from('admin_config')
      .select(BASE_SELECT)
      .in('config_key', ALLOWED_CONFIG_KEYS)
      .order('config_key', { ascending: true })
      .order('created_at', { ascending: true })

    if (baseError) {
      logger.error('[admin/keys] list failed', { detail: baseError.message })
      return NextResponse.json({ error: 'Failed to list keys.' }, { status: 500 })
    }
    return NextResponse.json({ keys: baseData ?? [], healthColumnsMissing: true })
  }

  return NextResponse.json({ keys: data ?? [] })
}

export async function POST(req: NextRequest) {
  let caller: { id: string; email?: string }
  try { caller = await requireAdmin(req) } catch (res) { return res as NextResponse }

  let body: { configKey?: unknown; label?: unknown; key?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }

  const configKey = typeof body.configKey === 'string' ? body.configKey.trim() : ''
  const label     = typeof body.label     === 'string' ? body.label.trim()     : ''
  const key       = typeof body.key       === 'string' ? body.key.trim()       : ''

  if (!ALLOWED_CONFIG_KEYS.includes(configKey as AllowedConfigKey)) {
    return NextResponse.json(
      { error: `configKey must be one of: ${ALLOWED_CONFIG_KEYS.join(', ')}.` },
      { status: 422 },
    )
  }
  if (!label) {
    return NextResponse.json({ error: 'label is required.' }, { status: 422 })
  }
  if (label.length > 80) {
    return NextResponse.json({ error: 'label must be 80 chars or fewer.' }, { status: 422 })
  }
  if (!key) {
    return NextResponse.json({ error: 'key is required.' }, { status: 422 })
  }
  if (key.length < 8) {
    return NextResponse.json({ error: 'key is too short (minimum 8 characters).' }, { status: 422 })
  }

  const last4 = key.slice(-4)

  let encrypted: { ciphertext: string; iv: string; authTag: string }
  try {
    encrypted = encryptSecret(key)
  } catch (err) {
    logger.error('[admin/keys] encryption failed', { detail: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { error: 'Failed to encrypt key. Verify KEY_ENCRYPTION_SECRET is configured.' },
      { status: 500 },
    )
  }

  const db = createServerClient()
  const { data: row, error: insertErr } = await db
    .from('admin_config')
    .insert({
      config_key:       configKey,
      label,
      value_ciphertext: encrypted.ciphertext,
      value_iv:         encrypted.iv,
      value_auth_tag:   encrypted.authTag,
      last4,
      status:           'active',
      created_by:       caller.id,
    })
    .select(BASE_SELECT)
    .single()

  if (insertErr || !row) {
    logger.error('[admin/keys] insert failed', { detail: insertErr?.message })
    return NextResponse.json({ error: 'Failed to store key.' }, { status: 500 })
  }

  invalidateKeyCache(CONFIG_KEY_TO_PROVIDER[configKey] ?? configKey)

  void writeAuditLog({
    actorId:    caller.id,
    actorEmail: caller.email ?? '',
    action:     'admin_config.create',
    targetType: 'admin_config',
    targetId:   row.id,
    metadata:   { configKey, label },
    ...requestContext(req),
  })

  return NextResponse.json({ key: row }, { status: 201 })
}
