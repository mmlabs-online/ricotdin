> Moved from CLAUDE.md §0.9 (ARC-19). Rules here are binding.

### 0.9 v2 admin API (ARC-10 done: 10a users, 10b operations, 10c configuration)

- **Package** `app/routers/admin/` (prefix `/admin`), pure rules in `app/domain/admin.py`. Every
  route depends on `current_admin` (`_common.py`): token role `admin` **and** `users.role =
  'admin'` + `disabled_at IS NULL` re-read per request, so a demoted or disabled admin loses the
  admin API at once (non-admin APIs still follow the ≤ 15 min token rule). All SQL as
  `ricotdin_service`.
- **Audit:** `write_audit(conn, admin, action, target_type, target_id, metadata)` inserts the
  `audit_logs` row **in the mutation's transaction** (v1 wrote it fire-and-forget). Metadata =
  ids, counts, field names, the admin's grant note — never meeting content, keys or secrets.
- **Users (10a):** `GET /admin/users?page&perPage(≤100)&search&month` (search = email or
  username, LIKE wildcards literal; month usage keeps tokens and audio seconds apart),
  `GET /admin/users/{id}`, `PATCH …/role {role}`, `PATCH …/status {disabled}` (disable →
  `disabled_at` + every refresh token revoked), `POST …/reset-password` (mails a reset link,
  `email_sent`; never returns the token), `DELETE /admin/users/{id}` (owned meeting audio +
  avatar deleted from Drive first, each in its own step, failures → `storageWarnings`; then the
  user row, everything cascades), `POST /admin/users/bulk {ids ≤ 50, action
  disable|enable|set_role, role?}` (caller skipped, unknown ids in `errors`, one transaction and
  one audit row), `GET|POST /admin/users/{id}/quota` (`admin_grant` via `quota_apply_movement`;
  ≤ 100 000 min / 1 000 000 queries per grant, v2 cap). Guards (v1 messages, 400): no demote /
  disable / delete of yourself or the last active admin; the admin rows are locked
  (`lock_admin_count`) so two admins cannot remove each other concurrently.
- Audit actions: `user.role_change {from,to}`, `user.disable`, `user.enable`,
  `user.password_reset`, `user.delete_started {files}` (committed before the Drive pass),
  `user.delete {meetings, files, files_failed}`, `user.bulk_<action>`,
  `quota.grant` (ledger key `admin_grant:<uuid>`). Admin role changes write `users.role` only
  (trigger mirrors `profiles.role`).
- **Locks:** admin rows and the target are locked `FOR NO KEY UPDATE` (never `FOR UPDATE`: that
  blocks the users' own FK inserts and deadlocked a disable against a concurrent refresh); the
  caller must be among the locked active admins (re-checked inside the mutation). Bulk locks ids
  in sorted order and is all-or-nothing. Delete first disables the account and revokes its
  tokens, deletes the files, then re-reads the keys before the row delete and gives keys that
  appeared meanwhile a second Drive pass. v2 additions: promotion only of an active, verified
  account (§0.3 pre-registration risk); reset mail limited like `/auth/forgot-password` (3/h per
  address); `page ≤ 10 000`; `month` 1970–2100; a grant that rounds to 0 s is refused;
  `email_sent: false` must be shown by ARC-14 (v1 answered 500 when the mail failed).
- **Open (owner decision pending):** a demoted admin keeps admin RLS reads in the non-admin APIs
  (all meetings, transcripts, chat retrieval) until the access token expires (≤ 15 min, §0.3);
  the admin API itself refuses at once.
- **Operations (10b, `ops.py`, pure `domain/admin_ops.py`):** `GET /admin/pipeline/overview`
  (counts + stuck = `processing`, not updated for 15 min and no queued/running job — a long
  transcription re-queues its poll without touching the meeting — + average done time),
  `GET /admin/pipeline/jobs?status=pending|processing|done|failed|stuck&page&perPage` (meeting
  metadata, owner, latest job status/step/attempts/`last_error` ≤ 500 chars — never summary, notes
  or transcript), `POST /admin/pipeline/{id}/requeue` (**failed or stuck meetings only**, 422
  otherwise — v1 §9d; a `done` meeting is re-run by its owner via `/process`; meeting →
  `pending`, ONE job via the unique index, audit `meeting.requeue`; nothing is cleared up front
  — v1 wiped transcript/notes first — the worker replaces each part as its step completes, so a
  re-run that fails half-way can leave a new transcript next to old notes; 409 before any change
  unless the worker can run it: own audio key, `gdrive` (v1 meetings wait for ARC-18), file
  mapped, no job queued/running; a new job = a new quota charge for the owner, owner decision
  2026-11-02), `GET /admin/pipeline/schedulers` (ARC-08e tasks, `stale` = not finished for two
  intervals), `GET /admin/usage` (meetings by status/age, Drive map totals), `GET /admin/ai-usage
  ?from&to(≤ 400 days)&groupBy=operation&userId` (grouped in SQL, units never summed together,
  key label + last4 only), `GET /admin/activity?userId&eventType&from&to`, `GET /admin/audit-logs
  ?actor&action(prefix, wildcards literal)&from&to`. A date-only `to` covers the whole day (also
  ai-usage: the v1 UI appended `T23:59:59Z`); dates outside 1970–2100 are ignored; bad uuids →
  400 (v1 crashed). ARC-14 must render activity `metadata` as text (users write their own
  `POST /activity` rows). v1's `POST /admin/pipeline/reconcile-quota` is not ported: the worker
  runs `wallet_reconcile` / `stuck_meetings` every 5 min (the service role cannot run them).
- **Configuration (10c, `config.py`, pure `domain/admin_config.py`):** `GET|POST /admin/keys`,
  `PATCH|DELETE /admin/keys/{id}` (config keys = `<catalog provider>_api_key` + Speechmatics;
  encrypted with `KeySource.encrypt`, 503 without `KEY_ENCRYPTION_SECRET`; key 8–512 visible ASCII
  chars; rows never carry ciphertext/IV/tag; last active key of a provider never disabled or
  deleted — 422, rows locked `FOR NO KEY UPDATE`; `keys.invalidate(provider)` after every commit;
  audit `admin_config.create|enable|disable|delete {configKey, label[, disabled_reason]}`),
  `GET|POST /admin/keys/healthcheck` (POST runs `run_key_health(group=SERVICE)` now, 10/h per
  process for all admins, audit `admin_config.healthcheck {summary}`), `GET /admin/config`,
  `PATCH /admin/config/{key} {value}` (known keys typed: `storage.audio_retention_days` null or
  1–3650, `user_hack_audio_render` boolean; strings ≤ 2000; `platform.config.invalidate`; audit
  `config.update {value}`; values read as `value::text` — the jsonb codec already decodes),
  `GET|PATCH /admin/generation-config` (v1 rules + the default must stay in the allow-list;
  `app_settings` upsert under an advisory lock; audit `generation_config.update`),
  `GET|POST /admin/features`, `GET|PATCH /admin/features/{id|KEY}` (keys `PREFIX-ID`, text caps,
  409 duplicate; audit `feature.create {key, module_prefix, title}` / `feature.update {key,
  changed_fields}`), `GET /admin/health` (database, Drive `check()`, per-provider active keys from
  the last check — no live probe, unlike v1 — and stale worker tasks; 503 when any check fails),
  `GET /admin/storage` (Drive health + map totals). v1's R2 `storage` config / orphans / cleanup
  routes are not ported (storage is Drive; R2 is only the ARC-18 source).
- 10c review follow-ups: key changes take a per-provider advisory lock first (two admins
  disabling two keys of one provider no longer deadlock); a provider's 401 marks expire after
  1 h (`INVALID_TTL_S`: the worker never sees the API's `invalidate`, so a topped-up key comes
  back on its own — revoke a leaked key at the provider, disabling is not revocation); NaN /
  Infinity config values → 422; feature arrays must be lists; feature bodies ≤ 1 MiB, list
  ≤ 200 per page; the key check limiter is one bucket for all admins; `/admin/health` adds
  `key_encryption` and failing worker tasks, and only providers in use (Gemini, Speechmatics,
  the allow-list) can be an error — others are a `warning`; it answers 503 until the worker has
  run every task once. ARC-14: render key labels, reasons and feature text as text; confirm
  before setting `storage.audio_retention_days` (irreversible on the next worker run).
