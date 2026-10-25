// POST /api/chat
//
// Full RAG chatbot pipeline:
//   authenticate → resolve/create session → persist user message → retrieve
//   transcript context (RLS-scoped) → generate grounded answer → persist
//   assistant message with citations → return { sessionId, message }
//
// Three scopes (at most one may be set per request):
//   meetingId set → single-meeting scope
//   folderId  set → folder scope (accessible meetings in the folder)
//   neither       → global scope (all user's accessible meetings)
//
// Access: viewer+ for meeting access (shared-folder members may use RAG chat).
// Each user gets their own chat_session row even for shared meetings/folders.
// Retrieval uses the user-scoped client (anon key + JWT) so RLS on
// transcript_chunks enforces shared-folder access automatically.

import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { createUserClient } from '@/lib/supabase/user-client'
import { retrieveContext } from '@/lib/rag/retrieve'
import { answerWithContext } from '@/lib/gemini/answer'
import { checkMeetingAccess, checkFolderAccess } from '@/lib/access'
import { logActivity } from '@/lib/activity/logActivity'
import { applyQuotaMovement } from '@/lib/quota/applyQuotaMovement'
import { deriveMeetingIds, validateChatScope, classifyChatOutcome } from '@/lib/rag/scope'
import { getGenerationConfig } from '@/lib/ai/config'
import { logger, describeError } from '@/lib/logger'
import type { HistoryMessage } from '@/lib/gemini/answer'
import type { Database } from '@/types/database'

const NO_CONTEXT_REPLY =
  "I couldn't find relevant information in the meeting transcript to answer that question. " +
  'Try rephrasing, or check that the meeting has finished processing.'

// Shown when retrieval itself fails (embedding provider / vector-search error).
// Deliberately distinct from NO_CONTEXT_REPLY so a real outage is never mistaken
// for "the transcript has nothing relevant".
const RETRIEVAL_ERROR_REPLY =
  "Sorry — I couldn't search this meeting right now due to a temporary problem with the " +
  'search service. This is not a problem with the meeting content. Please try again in a moment; ' +
  'if it persists, an administrator can check the AI provider keys and logs.'

const EMPTY_FOLDER_REPLY =
  'This folder has no meetings with transcripts yet. ' +
  'Add some meetings and process them before asking questions here.'

// ---------------------------------------------------------------------------
// Auth helper — returns userId AND jwt (needed for user-scoped Supabase client)
// ---------------------------------------------------------------------------

async function authenticateRequest(
  req: NextRequest,
): Promise<{ userId: string; jwt: string }> {
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) throw NextResponse.json({ error: 'Missing Authorization header.' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon)
    throw NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })

  const {
    data: { user },
    error,
  } = await createClient<Database>(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.getUser()

  if (error || !user)
    throw NextResponse.json({ error: 'Invalid or expired session.' }, { status: 401 })

  return { userId: user.id, jwt }
}

// ---------------------------------------------------------------------------
// GET /api/chat?meetingId=<id>  or  ?folderId=<id>
// Returns the most recent chat session + all its messages for the given scope.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  let userId: string
  try {
    ;({ userId } = await authenticateRequest(req))
  } catch (res) {
    return res as NextResponse
  }

  const url = new URL(req.url)
  const meetingId = url.searchParams.get('meetingId')
  const folderId  = url.searchParams.get('folderId')

  const db = createServerClient()

  if (meetingId) {
    // Meeting-scope history
    const { data: meeting } = await db
      .from('meetings')
      .select('id, user_id, folder_id')
      .eq('id', meetingId)
      .maybeSingle()
    if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })
    if (!(await checkMeetingAccess(db, meeting, userId, 'viewer'))) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
    }

    const { data: session } = await db
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('meeting_id', meetingId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!session) return NextResponse.json({ sessionId: null, messages: [] })

    const { data: messages } = await db
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true })

    return NextResponse.json({ sessionId: session.id, messages: messages ?? [] })
  }

  if (folderId) {
    // Folder-scope history
    if (!(await checkFolderAccess(db, folderId, userId, 'viewer'))) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
    }

    const { data: session } = await db
      .from('chat_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('folder_id', folderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!session) return NextResponse.json({ sessionId: null, messages: [] })

    const { data: messages } = await db
      .from('chat_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true })

    return NextResponse.json({ sessionId: session.id, messages: messages ?? [] })
  }

  // Neither: return empty (global scope has no persistent session anchor in GET)
  return NextResponse.json({ sessionId: null, messages: [] })
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let userId: string
  let jwt: string
  try {
    ;({ userId, jwt } = await authenticateRequest(req))
  } catch (res) {
    return res as NextResponse
  }

  // Stable ID for this user message — used as the quota dedup key so that
  // charge and refund are idempotent even if the request is retried.
  const userMsgId = randomUUID()

  // Parse and validate body
  let body: { message?: unknown; meetingId?: unknown; folderId?: unknown; sessionId?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const message   = typeof body.message   === 'string' ? body.message.trim()   : ''
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId        : null
  const folderId  = typeof body.folderId  === 'string' ? body.folderId         : null
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId        : null

  if (!message) return NextResponse.json({ error: 'message is required.' }, { status: 400 })

  const scopeError = validateChatScope(meetingId, folderId)
  if (scopeError) return NextResponse.json({ error: scopeError }, { status: 400 })

  const db = createServerClient() // service role for writes and access checks

  // ── Access checks + folder meeting resolution ──────────────────────────────

  // Single-meeting scope: verify viewer+ access; capture model lock for RAG answer.
  // AIP-04: cross-meeting scope (folder/global) uses the ADM-10 system default instead.
  let meetingModelCtx: { provider: string; model: string } | undefined
  if (meetingId) {
    const { data: meeting } = await db
      .from('meetings')
      .select('id, user_id, folder_id, generation_provider, generation_model')
      .eq('id', meetingId)
      .maybeSingle()
    if (!meeting) return NextResponse.json({ error: 'Meeting not found.' }, { status: 404 })
    if (!(await checkMeetingAccess(db, meeting, userId, 'viewer'))) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
    }
    if (meeting.generation_provider && meeting.generation_model) {
      meetingModelCtx = { provider: meeting.generation_provider, model: meeting.generation_model }
    }
  } else {
    // Cross-meeting path (folder or global scope): resolve answer-synthesis model
    // from the ADM-10 system default. getGenerationConfig() never throws — its
    // built-in FALLBACK is gemini:gemini-2.5-flash, so pre-migration state is safe.
    const cfg = await getGenerationConfig()
    meetingModelCtx = cfg.systemDefault
  }

  // Folder scope: verify viewer+ access, then resolve accessible meeting IDs.
  // Use the user-scoped client so RLS returns only meetings the caller can see.
  let folderMeetingIds: string[] | null = null
  if (folderId) {
    if (!(await checkFolderAccess(db, folderId, userId, 'viewer'))) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
    }

    const userClient = createUserClient(jwt)
    const { data: folderMeetings } = await userClient
      .from('meetings')
      .select('id')
      .eq('folder_id', folderId)

    folderMeetingIds = (folderMeetings ?? []).map((m) => m.id)
  }

  // Derive the meetingIds filter for retrieval
  const meetingIds = deriveMeetingIds(meetingId, folderMeetingIds)

  // ── Session resolution ─────────────────────────────────────────────────────
  let resolvedSessionId: string
  if (!sessionId) {
    const { data: session, error: sessionErr } = await db
      .from('chat_sessions')
      .insert({
        user_id:    userId,
        meeting_id: meetingId ?? null,
        folder_id:  folderId  ?? null,
        // folder_id column added by migration 018; not yet in generated Supabase types
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .select('id')
      .single()
    if (sessionErr || !session)
      return NextResponse.json({ error: 'Could not create chat session.' }, { status: 500 })
    resolvedSessionId = session.id
  } else {
    const { data: session } = await db
      .from('chat_sessions')
      .select('id, user_id')
      .eq('id', sessionId)
      .maybeSingle()
    if (!session) return NextResponse.json({ error: 'Session not found.' }, { status: 404 })
    if (session.user_id !== userId)
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
    resolvedSessionId = session.id
  }

  // ── Persist user message ───────────────────────────────────────────────────
  const { error: userMsgErr } = await db.from('chat_messages').insert({
    id:         userMsgId,
    session_id: resolvedSessionId,
    role:       'user',
    content:    message,
    citations:  [],
  })
  if (userMsgErr)
    return NextResponse.json({ error: 'Failed to save message.' }, { status: 500 })

  logActivity({
    userId,
    eventType: 'chat_message',
    meetingId,
    metadata: {
      sessionId: resolvedSessionId,
      ...(folderId ? { folderId } : {}),
    },
  })

  // ── Early return: empty folder ─────────────────────────────────────────────
  // Folder scope with no accessible meetings → skip quota + Gemini.
  if (folderId && folderMeetingIds !== null && folderMeetingIds.length === 0) {
    const { data: emptyMsg, error: emptyMsgErr } = await db
      .from('chat_messages')
      .insert({
        session_id: resolvedSessionId,
        role:       'assistant',
        content:    EMPTY_FOLDER_REPLY,
        citations:  [],
      })
      .select('*')
      .single()
    if (emptyMsgErr || !emptyMsg)
      return NextResponse.json({ error: 'Failed to save assistant message.' }, { status: 500 })
    return NextResponse.json({ sessionId: resolvedSessionId, message: emptyMsg })
  }

  // ── Load recent history ────────────────────────────────────────────────────
  const { data: historyRows } = await db
    .from('chat_messages')
    .select('role, content')
    .eq('session_id', resolvedSessionId)
    .order('created_at', { ascending: false })
    .limit(5)

  const history: HistoryMessage[] = (historyRows ?? [])
    .slice(1) // drop the user message we just inserted (it's first in DESC order)
    .reverse() // restore chronological order
    .map((r) => ({ role: r.role, content: r.content }))

  // ── QUO-03: Agent-query quota gate ────────────────────────────────────────
  // Runs after the access check and after the user message is persisted.
  // Deduped by userMsgId so a retried request never double-charges.
  // Actor-pays: charged to the ASKER (userId), not the folder/meeting owner.
  const quotaCharge = await applyQuotaMovement({
    userId,
    deltaAudioSeconds:  0,
    deltaAgentQueries: -1,
    reason:   'agent_query',
    dedupKey: `agent:${userMsgId}:charge`,
    allowOverdraw: false,
    meetingId,
    metadata: {
      session_id: resolvedSessionId,
      ...(folderId ? { folder_id: folderId } : {}),
    },
  })
  if (quotaCharge.status === 'insufficient') {
    return NextResponse.json(
      {
        blocked:           true,
        reason:            'insufficient_agent_balance',
        remaining_queries: quotaCharge.agentRemaining,
      },
      { status: 402 },
    )
  }

  // ── Retrieve context ───────────────────────────────────────────────────────
  // Uses the user-scoped client so RLS applies. After migration 012,
  // transcript_chunks SELECT policy includes shared-folder members, so viewers
  // of shared meetings/folders can use RAG automatically.
  const userClient = createUserClient(jwt)
  const usageCtx = { meetingId, userId }
  let chunks: Awaited<ReturnType<typeof retrieveContext>> = []
  let retrievalFailed = false
  try {
    chunks = await retrieveContext({ query: message, userClient, meetingIds, userId })
  } catch (err) {
    // A thrown error here means the search itself broke (embedding provider key,
    // vector-search RPC, etc.) — NOT that the transcript has nothing relevant.
    // Flag it so we surface an honest message instead of NO_CONTEXT_REPLY.
    // describeError unwraps Gemini/Postgres errors that String(err) would turn
    // into a useless "[object Object]".
    retrievalFailed = true
    logger.error('[chat] retrieval error', {
      meetingId: meetingId ?? undefined,
      userId,
      detail: describeError(err),
    })
  }
  logger.info('[chat] retrieval produced chunks', {
    meetingId: meetingId ?? undefined,
    count: chunks.length,
    retrievalFailed,
  })

  // Refund the 1 agent query charged upfront — the user got no real answer.
  async function refundQuery(reason: string): Promise<void> {
    await applyQuotaMovement({
      userId,
      deltaAudioSeconds:  0,
      deltaAgentQueries: +1,
      reason:   'refund',
      dedupKey: `agent:${userMsgId}:refund`,
      allowOverdraw: false,
      meetingId,
      metadata: { reason, session_id: resolvedSessionId },
    }).catch((e: unknown) =>
      logger.error('[chat] quota refund failed (non-fatal)', { detail: String(e) }),
    )
  }

  // ── Generate answer ────────────────────────────────────────────────────────
  let answer: string
  let citations: Awaited<ReturnType<typeof answerWithContext>>['citations'] = []

  const outcome = classifyChatOutcome(retrievalFailed, chunks.length)

  if (outcome === 'retrieval_error') {
    // Technical failure before any answer could be attempted — refund + be honest.
    await refundQuery('retrieval_failed')
    answer = RETRIEVAL_ERROR_REPLY
  } else if (outcome === 'no_context') {
    answer = NO_CONTEXT_REPLY
  } else {
    try {
      const result = await answerWithContext({
        question: message,
        chunks,
        history,
        ctx: { ...usageCtx, modelCtx: meetingModelCtx },
      })
      answer    = result.answer
      citations = result.citations
    } catch (err) {
      // Technical failure during synthesis — refund the 1 agent query.
      await refundQuery('answer_generation_failed')
      logger.error('[chat] answer generation error', { detail: String(err) })
      answer = 'I encountered an error while generating an answer. Please try again.'
    }
  }

  // ── Persist assistant message ──────────────────────────────────────────────
  const { data: assistantMsg, error: assistantMsgErr } = await db
    .from('chat_messages')
    .insert({
      session_id: resolvedSessionId,
      role:       'assistant',
      content:    answer,
      citations,
    })
    .select('*')
    .single()

  if (assistantMsgErr || !assistantMsg)
    return NextResponse.json({ error: 'Failed to save assistant message.' }, { status: 500 })

  return NextResponse.json({ sessionId: resolvedSessionId, message: assistantMsg })
}
