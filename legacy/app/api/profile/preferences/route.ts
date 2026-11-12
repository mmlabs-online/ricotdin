// GET  /api/profile/preferences — return user's model preference + allowed models
// PATCH /api/profile/preferences — save user's model preference
// Requires a valid session; non-admins can only read/write their own preference.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { getGenerationConfig, isModelAllowed } from '@/lib/ai/config'
import { listRegistered } from '@/lib/ai/registry'
import type { Database } from '@/types/database'

async function requireUser(req: NextRequest): Promise<string> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 })

  const authClient = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: { user }, error } = await authClient.auth.getUser()
  if (error || !user) throw NextResponse.json({ error: 'Invalid or expired session.' }, { status: 401 })
  return user.id
}

function modelDisplayLabel(provider: string, model: string): string {
  if (provider === 'gemini') return `Gemini — ${model}`
  if (provider === 'openai') {
    if (model === 'gpt-4o') return 'OpenAI — GPT-4o'
    if (model === 'gpt-4o-mini') return 'OpenAI — GPT-4o mini'
  }
  if (provider === 'grok') return `Grok — ${model}`
  return `${provider} — ${model}`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  let userId: string
  try {
    userId = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  const db = createServerClient()
  const [config, profileRow] = await Promise.all([
    getGenerationConfig(),
    db.from('profiles').select('default_provider, default_model').eq('id', userId).maybeSingle(),
  ])

  const registered = listRegistered()
  const allowedModels = config.allowedModels
    .filter((m) => registered.some((r) => r.provider === m.provider && r.model === m.model))
    .map((m) => ({ ...m, label: modelDisplayLabel(m.provider, m.model) }))

  return NextResponse.json({
    provider: profileRow.data?.default_provider ?? null,
    model:    profileRow.data?.default_model    ?? null,
    allowedModels,
  })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let userId: string
  try {
    userId = await requireUser(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: { provider: string | null; model: string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { provider, model } = body

  // Clear preference
  if (provider === null && model === null) {
    const db = createServerClient()
    const { error } = await db
      .from('profiles')
      .update({ default_provider: null, default_model: null })
      .eq('id', userId)
    if (error) return NextResponse.json({ error: 'Failed to clear preference.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Validate
  if (typeof provider !== 'string' || typeof model !== 'string') {
    return NextResponse.json({ error: 'provider and model must both be strings, or both null.' }, { status: 400 })
  }

  const config = await getGenerationConfig()
  if (!isModelAllowed(provider, model, config)) {
    return NextResponse.json(
      { error: `${provider}:${model} is not in the current allow-list.` },
      { status: 400 },
    )
  }

  const db = createServerClient()
  const { error } = await db
    .from('profiles')
    .update({ default_provider: provider, default_model: model })
    .eq('id', userId)
  if (error) return NextResponse.json({ error: 'Failed to save preference.' }, { status: 500 })

  return NextResponse.json({ ok: true })
}
