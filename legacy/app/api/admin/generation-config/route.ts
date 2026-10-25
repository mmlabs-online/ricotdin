// GET  /api/admin/generation-config — return current allow-list + system default + registry
// PATCH /api/admin/generation-config — update allow-list and/or system default
// Both routes are admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/server'
import { getGenerationConfig, saveGenerationConfig, invalidateConfigCache, isModelAllowed } from '@/lib/ai/config'
import { listRegistered } from '@/lib/ai/registry'
import { writeAuditLog, requestContext } from '@/lib/admin/audit'
import type { ModelPick } from '@/lib/ai/config'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const [config, registeredEntries] = await Promise.all([
    getGenerationConfig(),
    Promise.resolve(listRegistered()),
  ])

  const registeredModels = registeredEntries.map((e) => ({
    provider: e.provider,
    model: e.model,
    label: modelDisplayLabel(e.provider, e.model),
  }))

  return NextResponse.json({
    systemDefault: config.systemDefault,
    allowedModels: config.allowedModels,
    registeredModels,
  })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let admin: Awaited<ReturnType<typeof requireAdmin>>
  try {
    admin = await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  let body: { systemDefault?: ModelPick; allowedModels?: ModelPick[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { systemDefault, allowedModels } = body

  // Validate allowedModels: every entry must exist in the registry.
  if (allowedModels !== undefined) {
    if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
      return NextResponse.json({ error: 'allowedModels must be a non-empty array.' }, { status: 400 })
    }
    const registered = listRegistered()
    for (const m of allowedModels) {
      if (!m?.provider || !m?.model) {
        return NextResponse.json({ error: 'Each entry in allowedModels must have provider and model.' }, { status: 400 })
      }
      const inReg = registered.some((r) => r.provider === m.provider && r.model === m.model)
      if (!inReg) {
        return NextResponse.json(
          { error: `${m.provider}:${m.model} is not in the provider registry.` },
          { status: 400 },
        )
      }
    }
  }

  // Validate systemDefault: must be in the (new or current) allowedModels.
  if (systemDefault !== undefined) {
    const effectiveAllowList = allowedModels ?? (await getGenerationConfig()).allowedModels
    const fakeConfig = { systemDefault, allowedModels: effectiveAllowList }
    if (!isModelAllowed(systemDefault.provider, systemDefault.model, fakeConfig)) {
      return NextResponse.json(
        { error: `systemDefault (${systemDefault.provider}:${systemDefault.model}) must be in the allow-list and registry.` },
        { status: 400 },
      )
    }
  }

  await saveGenerationConfig({ systemDefault, allowedModels }, admin.id)
  invalidateConfigCache()

  void writeAuditLog({
    actorId: admin.id,
    actorEmail: admin.email ?? '',
    action: 'generation_config.update',
    targetType: 'app_settings',
    targetId: 'generation',
    metadata: { systemDefault, allowedModels },
    ...requestContext(req),
  })

  const updated = await getGenerationConfig()
  return NextResponse.json({ ok: true, config: updated })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function modelDisplayLabel(provider: string, model: string): string {
  if (provider === 'gemini') return `Gemini — ${model}`
  if (provider === 'openai') {
    if (model === 'gpt-4o') return 'OpenAI — GPT-4o'
    if (model === 'gpt-4o-mini') return 'OpenAI — GPT-4o mini'
  }
  if (provider === 'grok') {
    if (model === 'grok-4') return 'Grok — grok-4'
    if (model === 'grok-3-mini') return 'Grok — grok-3-mini'
    return `Grok — ${model}`
  }
  return `${provider} — ${model}`
}
