// GET /api/admin/health
//
// Runs connectivity checks against Supabase DB and every configured Gemini
// API key, then returns an aggregated health report.
//
// Gemini key sources (same order as pool.ts):
//   1. GEMINI_API_KEYS=key1,key2,key3  (comma-separated)
//   2. GEMINI_API_KEY_1 … GEMINI_API_KEY_20
//   3. GEMINI_API_KEY  (legacy single key)
//
// SECURITY: requires admin role.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/server'
import { buildHealthReport } from '@/lib/admin/health'
import type { CheckResult } from '@/lib/admin/health'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

async function checkSupabase(): Promise<CheckResult> {
  try {
    const db = createServerClient()
    const { error } = await db.from('profiles').select('id').limit(1)
    if (error) return { status: 'error', message: error.message }
    return { status: 'ok' }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// ---------------------------------------------------------------------------
// Gemini — per-key checks
// ---------------------------------------------------------------------------

function loadGeminiKeys(): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  const push = (raw: string | undefined) => {
    if (!raw) return
    const t = raw.trim()
    if (t && !seen.has(t)) { seen.add(t); keys.push(t) }
  }
  const csv = process.env.GEMINI_API_KEYS
  if (csv) csv.split(',').forEach(push)
  for (let i = 1; i <= 20; i++) push(process.env[`GEMINI_API_KEY_${i}`])
  push(process.env.GEMINI_API_KEY)
  return keys
}

function maskKey(key: string): string {
  return key.length >= 8 ? `...${key.slice(-4)}` : '...????'
}

async function probeGeminiKey(key: string): Promise<CheckResult> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1`,
      { signal: AbortSignal.timeout(8_000) },
    )
    if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` }
    return { status: 'ok' }
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Unknown error' }
  }
}

async function checkAllGeminiKeys(): Promise<Record<string, CheckResult>> {
  const keys = loadGeminiKeys()
  if (keys.length === 0) {
    return { Gemini: { status: 'error', message: 'No Gemini API keys configured' } }
  }

  const results = await Promise.all(keys.map((k) => probeGeminiKey(k)))

  const out: Record<string, CheckResult> = {}
  keys.forEach((k, i) => {
    const label =
      keys.length === 1
        ? 'Gemini'
        : `Gemini key #${i + 1} (${maskKey(k)})`
    out[label] = results[i]
  })
  return out
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (res) {
    return res as NextResponse
  }

  const [supabase, geminiChecks] = await Promise.all([
    checkSupabase(),
    checkAllGeminiKeys(),
  ])

  const report = buildHealthReport({ supabase, ...geminiChecks })
  const httpStatus = report.status === 'ok' ? 200 : 503
  return NextResponse.json(report, { status: httpStatus })
}
