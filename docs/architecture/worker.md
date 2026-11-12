> Moved from CLAUDE.md §0.7 (ARC-19). Rules here are binding.

### 0.7 v2 worker (ARC-08 done: 08a foundation, 08b transcription, 08c AI + analyse, 08d embed + deploy, 08e schedulers)

- **Process:** `python -m app.worker` (`app/worker/`), same image as the API, **its own container
  with only `DATABASE_URL_WORKER`** (+ `KEY_ENCRYPTION_SECRET`, `LOG_LEVEL`, `SENTRY_DSN`). It refuses
  to start (exit 2) if `DATABASE_URL`, `DATABASE_URL_APP`, `DATABASE_URL_SERVICE`, `JWT_PRIVATE_KEY`,
  `SMTP_PASSWORD` or a Supabase / migration credential is set (`policy.worker_env_problems`), and
  while a pipeline step is missing (all four are registered since 08d: start → transcribe_poll →
  analyse → embed). **Deploy target (08d):** the same image with `command: python -m app.worker`,
  reference `app/api/deploy/compose.example.yml` (own env file with only the worker values, no ports,
  `stop_grace_period: 30s`, read-only root, `TMPDIR=/work` on a disk volume — not tmpfs, which is
  RAM — `cap_drop: ALL`, `no-new-privileges`, health check `python -m app.worker.health` =
  heartbeat file touched every 30 s, fails after 90 s; a write error is logged, never fatal;
  compose does not restart an unhealthy container — ARC-15 adds autoheal). The worker needs a
  Gemini key even when analysis uses OpenAI/Grok (embeddings are pinned to Gemini). ARC-15 moves
  it into the deployment repo. **Image build context is the repo root:**
  `docker build -f app/api/Dockerfile .` (ignore rules `app/api/Dockerfile.dockerignore`; the image
  carries `ai-instruction/ai-gen/` at `/app/ai-instruction/ai-gen`). CI checks the prompt is in the
  image, the worker refuses a service credential and the health check fails without a heartbeat.
- **Runner** (`runner.py`, port of v1 `lib/jobs/worker.ts`): `claim_next_job` (`SKIP LOCKED`), one
  job at a time, poll 1 s, stuck sweep every 60 s (running > 15 min). Each step runs in a private
  temp dir `ricotdin-job-*` (removed after; leftovers older than 1 h are removed at startup) with a
  12 min timeout (< the 15 min stuck threshold). Every job write — also the step's own payload write
  — is guarded by `status='running' AND locked_by=<worker id>` (a job the sweeper took back is never
  overwritten; `start` then rolls back its reserve: `JobLockLost`). Steps return
  `Advance(step, payload, delay)` / `Done(payload, activity)` / `Fail(message, metadata)`; unknown
  step → terminal. SIGTERM: stop claiming; after 8 s (below docker's default 10 s) a running step is
  cancelled and its job released (queued at once, attempts unchanged). Loop errors (database down)
  back off 1 → 30 s and reach Sentry at most once a minute.
- **Errors** (`errors.py`): `PipelineError(message, detail=)` = terminal, never retried (bad or
  unreadable file — also an ffprobe timeout —, forged key, audio > 6 h, unknown step / provider /
  model, provider rejection); typed `AppError` 4xx terminal, 503/429 transient; anything else
  transient. Transient → queued with backoff 2 s·2ⁿ⁻¹ ≤ 5 min ±25 %, until `max_attempts`.
  Terminal / exhausted / stuck-exhausted / **deadline** (6 h from `payload.started_at`, bounds
  re-queued polling, 08b) → job failed, **refund** (`pipeline_refund`), meeting failed (never a
  `done` meeting), activity `processing_failed` (owner decision 2026-11-02: the stuck sweep refunds
  too; v1 did not).
- **Messages** (`messages.py`): `meetings.error_message` and activity metadata get only text written
  for users (`user_message`: a `PipelineError` message, an `AppError` public message, the
  `QUOTA_BLOCKED: …` text, else "Processing failed. Please try again or contact an
  administrator."). The full redacted detail (stderr, driver errors) goes only to `jobs.last_error`
  (admin) and the logs (`error_text`).
- **Quota** (`quota.py` + SQL wrappers of migration 0005): dedup keys are **per job** —
  `gen:<job_id>:reserve|settle|refund` (owner decision 2026-11-02; v1 used the meeting id, so a
  requeue/reprocess was never charged again). Each process/requeue inserts a new job, so each run is
  charged once; retries of a job stay idempotent. The worker **cannot call `quota_apply_movement`**;
  it has three SECURITY DEFINER wrappers: `pipeline_reserve(job, seconds)` (1–86400 s, running job
  only, user = the job's meeting owner), `pipeline_refund(job)` (exactly the reserve ledger row's
  amount, once; nothing without a job-keyed reserve or after a settle — so migrated v1 jobs never get
  a free refund), `pipeline_settle(job, actual)` (08b: reserved − actual, 0–86400 s, not after a
  refund). Amounts never come from `jobs.payload`. Each wrapper first takes a per-job advisory
  transaction lock; refund needs a `failed` job (the runner fails the job first, same transaction),
  reserve and settle a `running` one — so a refund and a settle never both apply. The reserve and the payload's `reserve_done`
  (true stays true) are written in one transaction. v1's `reconcile.ts` (refund stuck reservations)
  is not ported: the runner's stuck sweep refunds by job key; 08e only fails orphaned meetings.
- **Step `start`** (`start.py`): claim meeting `pending|failed → processing` (a `processing` meeting
  is a restart), `owned_audio_path` (forged → terminal), `storage_provider` must be `gdrive`,
  model-lock hook (`lock_generation_model`, no-op until 08c), download (map lookup in a short
  transaction, streaming outside it), ffprobe (audio-only; `source='video'`: video mode + `-vn` mp3
  extraction, moved here from `/uploaded`), estimate = ceil(ffprobe) or `duration_seconds` (> 6 h →
  terminal), reserve (insufficient → `QUOTA_BLOCKED: …`, no retry), transcode mono 16 kHz 64 kbps
  mp3 (failure keeps the original), `Transcriber.submit` (language auto-detect, v1) →
  `transcribe_poll` after 5 s. The extracted audio of a video is not stored: `/media` still serves
  the original video.
- **Transcription (08b)** — `speechmatics.py` (pure json-v2 parse, untrusted: types, finite numbers,
  bounded labels/language), `speechmatics_client.py` (`SpeechmaticsTranscriber`, created once in
  `__main__`), step `transcribe_poll.py`; registry `steps.py`.
  - One key per provider job: `payload.transcriber_key_ref` = `id:<admin_config id>` or
    `env:<sha256[:16]>` (never the key). New jobs take the key with the fewest jobs in flight in
    this process (counts kept per ref, survive key reloads). 401 → `KeySource.mark_invalid`
    (submit retried with another key; a poll whose key is not usable now is retried, bounded by
    attempts + the 6 h deadline). GET: 429/5xx/network → 8 tries, 0.6 → 10 s, then transient.
    POST (creates a billed job): retried only on connect errors, 429, 503. Other 4xx → terminal
    "could not process". Transcript ≤ 32 MiB, status ≤ 1 MiB; job ids `[A-Za-z0-9_-]{1,64}`.
    Slot counts are per provider job (release is idempotent; terminal poll errors release).
  - Known, accepted: a crash/timeout between a provider submit and the committed `Advance` (start
    or the language retry) leaves an orphan provider job (billed at Speechmatics, not to quota);
    step retries count against the job's `max_attempts` across steps; failed provider calls
    write no `usage_log` row yet.
  - Poll: `running` → again in 5 s (no attempt); `done` → no speech = terminal + full refund
    (spec; v1 job path marked done); else ONE transaction guarded by `locked_by`:
    `transcription_settled` in the payload, `pipeline_settle(job, ceil(seconds))`, replace
    segments (and old chunks), `meetings.language`, `usage_log` (`audio_seconds`, `key_id` only if
    the admin key still exists) → `analyse`. A re-run with `transcription_settled` skips to
    `analyse`. Language-detect rejection (first time) → re-download, transcode, resubmit `en`.
- **AI layer (08c, `app/services/ai/`; also used by the API's `regenerate`):**
  - `catalog.py` = providers (`name`, `kind`, `base_url`) + models (the only model list;
    `domain/models.REGISTERED` derives from it). **Adding a provider:** OpenAI-compatible (DeepSeek,
    Mistral, …) = catalog rows only; its own API (Anthropic/Claude) = `adapters/<x>.py` + an
    `ADAPTERS` entry in `service.py` + catalog rows. Keys: admin key `<name>_api_key` or env
    `<NAME>_API_KEY` (generic fallback in `keys/source.py`). Users only get a model after an admin
    adds it to `generation.allowed_models`.
  - Adapters are stateless REST (no SDK): Gemini key in the `x-goog-api-key` header (never the
    URL), OpenAI-compatible Bearer + Structured Outputs `strict`. Schemas are written once,
    neutral (`schema.py`), converted per provider. Errors carry provider + status + short code only.
  - `AIService.generate_json`: one `KeyPool` per provider, rebuilt only when the key set changes;
    429 → cooldown + rotate, 401 / API_KEY_INVALID / OpenAI `insufficient_quota` → key disabled
    process-wide; refusal, safety block, 400/404/413/422 → `AIRejected` (422, terminal, not
    rotated); `ParseFailed` → one strict retry on the SAME key, then `AIBadOutput` (502, terminal);
    exhausted / network / no key → 503 (worker retries; when every key is only cooling down,
    `AIUnavailable.retry_after` is set and `analyse` re-queues itself after it without using an
    attempt). A parser exception other than `ParseFailed` counts as `ParseFailed` (never rotates).
    Gemini `RetryInfo.retryDelay` sets the cooldown; xAI's 400 "Incorrect API key" → key disabled.
    A `usage_log` row per provider request, also for cancelled calls (shielded write, ≤ 5 s)
    (`tokens`, `ok` / `rate_limited` / `error`, `key_id` only if the admin key exists), best effort.
    New adapters: map bad-key and out-of-credits answers to 401 (`types.py` docstring). Read timeout
    300 s.
  - Model lock (`model_lock.py`): stored pair wins; else upload pick (`payload.preferred_*`) →
    `profiles.default_*` → `generation.system_default` (each only if allowed + registered), written
    once (`WHERE generation_provider IS NULL`) at `start` (or at `analyse` / `regenerate` for older
    meetings).
  - Analysis (`analysis.py`): v1 prompt format (`[N] Speaker (s.s): text`, MEETING_DATE), prompt
    text from `ai-instruction/ai-gen/generate-meeting.md` (`prompts.py`: only the repository root —
    five levels above the module — or `/app`, where the image carries it; never a walk up the tree). Untrusted output: fields fall back one by one, bad items
    dropped, `due_date` must be a real `YYYY-MM-DD`, `proposed_at` an ISO date-time (no offset =
    UTC), dates only 1970–2100, text bounded without NUL / lone surrogates, no summary and no
    notes → `ParseFailed` (its detail never quotes the answer: meeting content).
  - Step `analyse`: meeting not `processing` → job done; no segments → terminal; AI call outside any
    transaction; then ONE transaction guarded by `locked_by`: `payload.analysis_done`, summary +
    notes, to-dos + calendar replaced → `embed`. A re-run with `analysis_done` skips the AI.
  - `POST /meetings/{id}/regenerate` (owner only; editor/viewer/stranger 403 like other meeting
    writes; 404 unknown): 409 while `pending`/`processing` or while a job is queued/running (also
    re-checked in the final UPDATE, so a queued reprocess is never ended by our `done`), 422 without
    transcript, 10 per user per
    hour (`app.state.regenerate_limiter`), the locked model, overwrites summary + notes and sets
    `done` (v1); to-dos/calendar untouched. `app.state.ai` is the API's `AIService`.
  - Open / accepted: regenerate's limiter is per process; a stored model lock is not re-checked against the allow-list (v1
    AIP-03); a provider error during the strict retry rotates and starts the attempt again; a key
    pool rebuild (key set changed, e.g. after a 401) forgets the other keys' cooldowns.
- **Step `embed` (08d, `embed.py` + pure `chunk.py`, v1 `chunk.ts`):** ~1 200 characters per
  chunk with one segment of overlap; `AIService.embed` = `catalog.EMBEDDING` (Gemini
  `gemini-embedding-001`, 768 dims, pinned: changing it means re-embedding every meeting),
  `batchEmbedContents` batches of 100, each through the pool; wrong count/dimension/non-finite →
  `AIBadOutput`; usage provider `gemini-embedding` (v1 label), quantity = tokens or the batch size.
  Components must be finite and within ±1e3 (float4 column). Then ONE transaction guarded by
  `locked_by`: the job closed (`Done(closed=True)`: the runner writes nothing), chunks replaced
  (`CAST(:e AS vector)`), meeting `processing → done` (`error_message` cleared), activity
  `processing_done` — so a crash never leaves a done meeting with a running job. A meeting not
  `processing` ends the job without work; rate-limited keys re-queue `embed` without an attempt.
- **Regenerate quota (owner decision 2026-11-03):** charged like one generation —
  `regenerate_charge_seconds` = ceil(last segment `end_ms`) else `duration_seconds`, 1–86 400 s —
  via `quota_apply_movement` (service role, reason `generate`, key `regen:<uuid>:charge`, no
  overdraw) in the same transaction as the checks, BEFORE the AI call; short balance → 402
  `QUOTA_BLOCKED: …`; any failure after the charge (AI error, 409/404 at save, cancel) refunds it
  (`regen:<uuid>:refund`, shielded, ledger `meeting_id` NULL + id in metadata: the meeting may be
  gone). 409/422 refusals happen before the charge (free): also 409 "did not finish processing"
  when the meeting has no `transcript_chunks`, and 409 while a regenerate of the same meeting is
  in flight in this process (`app.state.regenerating`). Accepted: a cancel exactly at a commit can
  refund a saved result or keep a charge; 08e's quota reconcile must ignore `regen:*` keys.
- **Schedulers (08e, `schedule.py` + `tasks/`, run by every worker next to the job loop):** each
  task has a `scheduler_runs` row (migration `0006`); a worker runs it only after a compare-and-set
  lease (no live lease AND last start older than the interval), so several workers never run the
  same task and "due" survives restarts; 15 min timeout < 20 min lease; checked every 30 s;
  `last_status` ok/error + short detail (error = type name only).
  - `key_health` (24 h, v1 §9i): every `admin_config` `*_api_key` row, active and disabled
    (`KeySource.stored_keys`), probed by catalog `kind` (Gemini `GET /models` with the
    `x-goog-api-key` header, OpenAI-compatible `GET /models` Bearer, `probe_model` set → 1-token
    chat POST: Grok; Speechmatics `GET /v2/jobs?limit=1`): 2xx/429 healthy, 401/403 unhealthy,
    else / network unknown, undecryptable → unhealthy → `health_*` columns. Unlike v1 no key ever
    goes in a URL; details never carry bodies or keys. Keys are not auto-disabled (v1).
  - `retention_purge` (24 h, v1 §9m): off unless `storage.audio_retention_days` is 1–3650; `done`
    meetings created strictly before the cutoff with no queued/running job, oldest first,
    ≤ 500/run; own key and Drive only — both filtered in SQL, so v1 `r2`/`supabase` meetings
    (waiting for ARC-18) never fill the batch; the row is re-read (`FOR UPDATE`) right before the
    delete (its own step), then CAS `audio_path = NULL, audio_purged_at = now()` +
    `retention_purge_audit` (SECURITY DEFINER, forced `system:retention`; only a `done` meeting
    purged in the last hour, its own key no longer mapped, days 1–3650, one row per meeting).
    Accepted: a reprocess queued between the committed Drive delete and the CAS leaves
    `audio_path` pointing at a deleted file (that job fails terminally). Runs at the first worker
    start (no 60 s delay as in v1): **ARC-15:** set `storage.audio_retention_days` only after the
    ARC-18 copy.
  - `wallet_reconcile` (5 min, v1 QUO-04): `quota_reconcile_wallets(run)` (SECURITY DEFINER; a run
    already going → returns at once; candidates found without locks, then each re-checked under
    `FOR UPDATE SKIP LOCKED` — never all wallets locked): a wallet ≠ its ledger sum is SET to the
    sum with a zero-delta `adjustment` row (`reconcile:<user>:<run>`, before/after in metadata).
    v1 added the drift to both sides, so it never closed and moved the balance every run
    (BUG-021, v1 only). **ARC-15:** the first run after the data migration rewrites any v1 drift:
    count drifted wallets on the rehearsal data first.
  - `stuck_meetings` (5 min): `processing` for > 30 min (`updated_at`) with no queued/running job
    → `failed` + the timeout message + `processing_failed`, and `legacy_reserve_refund` (SECURITY
    DEFINER) returns a v1 meeting-keyed reserve (`gen:<meeting>:reserve`, no settle/refund, once,
    failed meetings only; v1 QUO-02). Stuck jobs are failed and refunded by the runner.
  - `scheduler_runs.lease_until` ≤ `last_started_at + 1 h` (CHECK) — a compromised worker can still
    push `last_started_at` into the future (ARC-10's admin view should flag a stale
    `last_finished_at`); each stuck meeting is handled in its own savepoint; the lease is released also on shutdown (shielded, ≤ 5 s). Key health skips the
    run when `KEY_ENCRYPTION_SECRET` is unset; one bad key is `unknown`, never fatal.
- **ARC-15 ordering:** jobs of v1 meetings (`storage_provider` `r2`/`supabase`) fail terminally in
  `start` until the migration has copied their files to Drive (ARC-18, `--confirm-drive-folder`) —
  run the full migration before starting the worker (or keep the worker stopped until then).
- **ffmpeg/ffprobe on untrusted files** (`audio.py`): `-protocol_whitelist file`, `-format_whitelist`
  of our upload demuxers (an HLS/concat playlist disguised as audio is refused), stdin `/dev/null`,
  a minimal environment (`PATH`, `LANG`/`LC_ALL=C`: no database URL, no `KEY_ENCRYPTION_SECRET`),
  `-threads 2`, `-t 6h`, `-fs 1 GiB`, RLIMITs (2 GiB address space, file size, CPU, no core dumps),
  timeouts (probe 60 s, ffmpeg 8 min; the process group is killed). Gemini audio transcription and
  long-audio chunking are **not ported** (owner decision 2026-11-02: dead code in v1).
- **Worker grants (migration `0005_worker_grants`):** SELECT `meetings` + UPDATE of status,
  error_message, summary, notes, language, generation_provider/model, duration_seconds, audio_path,
  audio_purged_at; SELECT `jobs` + UPDATE of status, step, attempts, last_error, run_after, payload,
  locked_at, locked_by (no INSERT/DELETE); SELECT/INSERT/UPDATE/DELETE `transcript_segments`,
  `transcript_chunks`, `todos`, `calendar_suggestions`, `storage_objects`; SELECT `drive_config`,
  `admin_config` (+ UPDATE of health_* / last_used_at), `app_config`, `app_settings`,
  `quota_wallets`, `profiles(id, default_provider, default_model)`; INSERT only `usage_log`,
  `activity_log` (never `audit_logs` / `quota_ledger`); SELECT + UPDATE `scheduler_runs` (0006);
  explicit EXECUTE only `claim_next_job`, the three `pipeline_*` wrappers and (0006)
  `quota_reconcile_wallets` + `retention_purge_audit` (functions PUBLIC-executable since v1 — `can_access_meeting`,
  `match_transcript_chunks`, triggers, extensions — stay so). `service_all` keeps the worker only on
  those tables. A worker feature needing more = a new migration +
  `tests/test_worker_grants_integration.py`. The `/media` lookup (worker) still works. Downgrade
  restores the 0004 privileges exactly (tested).
- **What a worker breach still exposes:** SELECT on all meeting content (transcripts, notes, chunks,
  to-dos) of every user, DELETE on `storage_objects` (and the Drive files through the token), the
  Drive refresh token (`drive_config` + `KEY_ENCRYPTION_SECRET`) and the decrypted provider keys.
  Since 0006 also: one bounded `system:retention` audit row per meeting it first empties (it can
  UPDATE `audio_path`), running the wallet reconcile (sets wallets to the ledger sum, cannot move
  balances), refunding a failed v1 meeting's own reserve, and delaying schedulers ≤ 1 h per lease.
  **ARC-15 follow-up:** run ffmpeg/ffprobe sandboxed — separate uid, no network, seccomp / read-only
  root (or a separate sidecar without database or key access).
- **Data migration (§0.5):** the ARC-03 preflight blocks when v1 has more than one queued/running job
  per meeting (the unique index would abort the copy) and prints the `UPDATE` that fails the extras
  in Supabase (keeps the newest).
