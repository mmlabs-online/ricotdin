> Moved from CLAUDE.md §0.8 (ARC-19). Rules here are binding.

### 0.8 v2 chat / RAG API (ARC-09)

- **Routes** (`app/routers/chat.py`, pure `app/rag/scope.py` + `app/rag/answer.py`):
  `POST /chat {message, meetingId? | folderId?, sessionId?}` → `{sessionId, message}`;
  `GET /chat?meetingId= | folderId= | sessionId=` → latest session + messages (none → empty).
  Status codes = v1: meeting 404 unknown / 403 no role (viewer+ needed); folder 403 unless owner
  or share; foreign session 403 on POST, 404 on GET. v2 additions: a session continues only in
  its own scope (400), message ≤ 4000 chars, 30 questions per user per 10 min
  (`app.state.chat_limiter`, in-process).
- **Retrieval:** the question is embedded with `catalog.EMBEDDING` (`embed-query` usage row),
  then `match_transcript_chunks(vector, 8, ids)` runs **as `ricotdin_app` in
  `app_transaction`**, so RLS on `transcript_chunks` (`can_access_meeting`) limits every scope;
  `keep_chunks` then drops rows below similarity 0.5 and rows outside the requested meetings.
  Folder scope = the folder's meetings visible to the caller under RLS (empty → fixed reply, no
  charge, no AI call). Global = no filter (RLS only). Never run the search as a service role.
- **Answer:** `AIService.generate_json` (operation `chat`, no strict retry). Excerpts and history
  are untrusted (the system prompt says so); a citation is kept only if its `chunk_id` was
  retrieved, and its meeting/times come from that chunk. Bad output → error reply (v1 showed the
  raw text). Model: meeting chat = the meeting's locked pair, else the system default; folder /
  global = the system default (AIP-04). Chat does not lock a model.
- **Quota (v1 QUO-03, actor pays):** one agent query per question via `quota_apply_movement`
  (`agent:<message id>:charge`, no overdraw) in the same transaction as the user message;
  none left → 402 `insufficient_agent_balance` + `remaining_queries`, and the question is not
  saved. Retrieval or answer failure (also a cancel) → `agent:<id>:refund` (ledger `meeting_id`
  NULL). "Nothing relevant" is charged (v1).
- Writes (`chat_sessions`, `chat_messages`, ledger, activity `chat_message`) run as
  `ricotdin_service` after the checks; AI calls hold no database connection.
- **Prompt:** excerpts in `<excerpt chunk_id=… source="own|shared">`, history in `<history>`,
  the question in `<question>`; those tags are stripped from all untrusted text. A folder share
  lets its owner put text in another user's global/folder chat (indirect prompt injection:
  misinformation only — no tools, citations validated). **ARC-11/13 must render chat answers as
  plain text or sanitised markdown without images or remote links** (else exfiltration).
- Body ≤ 64 KiB (413 `payload_too_large`, `json_object(max_bytes=)`). Messages are written with
  `clock_timestamp()` so a question always sorts before its reply. A reply that was committed is
  never refunded. 402 body = the v2 error envelope (`error.code`), not v1's `{blocked, reason}`.
- **Refunds (SEC-05, owner decision 2026-11-09):** only the model refusing the question itself
  (`AIRefused`, a subclass of `AIRejected` raised for `ModelRefused`: safety block / refusal) keeps
  the charge (`rag.answer.answer_refund_reason`). Everything else is ours and refunded: retrieval
  error, `AIUnavailable`, `AIBadOutput`, a request we built badly (unknown / retired model 404,
  prompt too large 413 — plain `AIRejected`), cancel.
