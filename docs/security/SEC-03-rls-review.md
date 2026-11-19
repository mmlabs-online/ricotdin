# SEC-03 — Full RLS / Access-Control Audit

> Historical v1 review. v1 and Supabase are retired (ARC-16); the Supabase REST paths below no longer exist.

**Date:** 2026-06-25  
**Status:** Phase 3 complete — all 6 findings implemented in migrations 022–025.  
**Scope:** All Postgres tables, RLS policies, SECURITY DEFINER functions, route-layer access checks — triggered by COM-05 (folder sharing) and new QUO tables.  
**FIX_IN_THIS_RUN = false.** Approve specific items before Phase 3 begins.

---

## 1. Canonical ACCESS_PREDICATE (after COM-05)

Established from `public.can_access_meeting(p_meeting_id, p_min_role)` in migration 012:

```
User U can access meeting M at role R when:
  (a) M.user_id = U                                                      → owner
  (b) M.folder_id IS NOT NULL AND folder.user_id = U                     → folder owner
  (c) M.folder_id IS NOT NULL
      AND folder_shares WHERE folder_id = M.folder_id
          AND user_id = U
          AND (R = 'viewer' OR fs.role = 'editor')                       → grantee
```

Role ladder: `viewer < editor < owner`. The predicate is correctly asymmetric:  
- `p_min_role = 'viewer'`: (a), (b), (c) with any grantee role  
- `p_min_role = 'editor'`: (a), (b), (c) only when `fs.role = 'editor'`

The TypeScript mirror (`lib/access/index.ts → checkMeetingAccess`) is logically identical. Both are confirmed correct.

---

## 2. Table Inventory — RLS Posture

All 19 tables have RLS **enabled**. No table is silently open or silently denying all operations.

| Table | RLS | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `meetings` | ✓ | owner/admin/viewer+ | owner/admin | owner/admin/editor+ | owner/admin/**editor+** |
| `transcript_segments` | ✓ | owner/admin/viewer+ | owner/admin | owner/admin | owner/admin/**editor+** |
| `transcript_chunks` | ✓ | owner/admin/viewer+ | owner/admin | owner/admin | owner/admin |
| `todos` | ✓ | owner/admin/viewer+ | owner/admin | owner/admin/editor+ | owner/admin/editor+ |
| `calendar_suggestions` | ✓ | owner/admin/viewer+ | owner/admin | owner/admin/editor+ | owner/admin/editor+ |
| `chat_sessions` | ✓ | own-user/admin | own-user + viewer+ on meeting | own-user/admin | own-user/admin |
| `chat_messages` | ✓ | session-owner/admin | session-owner | session-owner/admin | session-owner/admin |
| `profiles` | ✓ | self/admin | (none — service-role only) | self (col-level) | (none) |
| `folders` | ✓ | owner/grantee | owner | owner | owner |
| `folder_shares` | ✓ | folder-owner (ALL) + grantee (SELECT) | owner-only | owner-only | owner-only |
| `audit_logs` | ✓ | admin only | (none) | (none) | (none) |
| `usage_log` | ✓ | admin only | (none) | (none) | (none) |
| `admin_config` | ✓ | admin only | (none) | (none) | (none) |
| `app_config` | ✓ | admin only | (none) | (none) | (none) |
| `activity_log` | ✓ | admin only | (none) | (none) | (none) |
| `features` | ✓ | admin only | (none) | (none) | (none) |
| `quota_wallets` | ✓ | own-row + admin all | (none) | (none) | (none) |
| `quota_ledger` | ✓ | own-row + admin all | (none) | (none) | (none) |
| `jobs` | ✓ | own-meeting-owner + admin all | (none) | (none) | (none) |

Cells marked **(none)** correctly deny that verb via missing policy (RLS-enabled table, no matching policy → deny). This is correct for tables where writes go exclusively through the service-role client.

---

## 3. Findings — Severity-Ranked

### FINDING-1 · HIGH · Admin RLS bypass exposes all user meeting content

**Tables:** `meetings`, `transcript_segments`, `transcript_chunks`, `todos`, `calendar_suggestions`, `chat_sessions`, `chat_messages`

**Current policy expression (representative):**
```sql
-- meetings_select (migration 012)
USING (
  auth.uid() = user_id
  OR auth.jwt()->>'user_role' = 'admin'          -- ← this branch
  OR public.can_access_meeting(id, 'viewer')
);
```
The same `auth.jwt()->>'user_role' = 'admin'` branch appears in SELECT, UPDATE, and DELETE policies on every content table.

**Why it's a problem:**  
Any admin user — using the public Supabase REST API with the anon key and an admin JWT — can read, update, and delete the meeting content (transcripts, summaries, notes, todos, chat history) of every user on the platform. This contradicts the stated `ADMIN_CONTENT_ACCESS = manage_accounts_only` intent (BRD Open Question 2, privacy-first).

**Actual admin operations that DO work without this bypass:**  
All admin pipeline operations (`GET /api/admin/pipeline/overview`, `POST /api/admin/pipeline/:id/requeue`, etc.) use `createServerClient()` (service-role key), which bypasses RLS entirely. Removing the admin bypass from content table RLS policies does **not** break any existing admin route.

**Blast radius:**  
Full read/write/delete access to meeting content of all users, accessible with just a valid admin JWT + the public anon key.

**Proposed fix:**  
Remove the `OR auth.jwt()->>'user_role' = 'admin'` clause from SELECT/UPDATE/DELETE policies on: `meetings`, `transcript_segments`, `transcript_chunks`, `todos`, `calendar_suggestions`, `chat_sessions`, `chat_messages`. Keep the admin bypass on management tables only (`profiles`, `audit_logs`, `usage_log`, `admin_config`, `app_config`, `activity_log`, `features`, `quota_wallets`, `quota_ledger`, `jobs`).

**Decision required:** See Section 5 — this fix implements the `manage_accounts_only` intent. Confirm before Phase 3.

**Two-sided test:**
- Admin (anon key + admin JWT) SELECT on `meetings` → zero rows for other users (no admin bypass)
- Admin service-role pipeline requeue → still works (service role is unaffected by RLS)

---

### FINDING-2 · HIGH · Shared editors can permanently delete meetings they don't own

**Path:** `meetings_delete` RLS policy + `DELETE /api/meetings/:id` route

**Current RLS policy:**
```sql
CREATE POLICY "meetings_delete"
  ON meetings FOR DELETE
  USING (
    auth.uid() = user_id
    OR auth.jwt()->>'user_role' = 'admin'
    OR public.can_access_meeting(id, 'editor')    -- ← editors included
  );
```

**Current API route check (app/api/meetings/[id]/route.ts:135):**
```typescript
// Editor+ required to delete — editors can delete meetings they don't own
if (!(await checkMeetingAccess(db, meeting, caller.id, 'editor'))) {
  return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
}
```

Both layers grant editors delete permission. The route comment explicitly acknowledges the behavior.

**Why it's a problem:**  
A user who is invited to a shared folder with `role = 'editor'` can permanently delete every meeting in that folder, including meetings owned by the folder owner or other editors. Audio files are also deleted before the row is removed (`deleteObject` is called first). The deletion is irreversible.

**Blast radius:**  
Any editor in any shared folder can silently destroy all meetings and audio they have editor access to, regardless of who owns them. If a folder owner shares a folder with 5 people as editors, any one of those 5 people can destroy the folder owner's data.

**Proposed fix:**  
Restrict meeting deletion to owner and admin only. Update both the RLS policy and the API route:

```sql
-- Replace meetings_delete policy:
CREATE POLICY "meetings_delete"
  ON meetings FOR DELETE
  USING (
    auth.uid() = user_id
    -- admin removed per FINDING-1 discussion; keep if ADMIN_CONTENT_ACCESS = full
  );
```

```typescript
// Route: replace editor+ check with owner-only
if (meeting.user_id !== caller.id) {
  return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
}
```

**Two-sided test:**
- Meeting owner calls DELETE → succeeds
- Shared editor calls DELETE on a meeting they don't own → 403

---

### FINDING-3 · MEDIUM · `transcript_segments` DELETE allows editors — inconsistent with `transcript_chunks`

**Tables:** `transcript_segments` (inconsistent), `transcript_chunks` (correct)

**Current `transcript_segments_delete`:**
```sql
USING (
  EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  OR auth.jwt()->>'user_role' = 'admin'
  OR public.can_access_meeting(meeting_id, 'editor')   -- ← editors allowed
);
```

**Current `transcript_chunks_delete`:**
```sql
USING (
  EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_id AND m.user_id = auth.uid())
  OR auth.jwt()->>'user_role' = 'admin'
  -- no editor branch here
);
```

**Why it's a problem:**  
Editors can delete individual transcript segments from a meeting they don't own. No API route currently exposes a direct DELETE for transcript segments (the only deletions are via meeting delete cascade or pipeline requeue — both service-role). However, a crafty editor could call the Supabase REST API directly (anon key + editor JWT) to delete transcript rows one by one, corrupting a meeting's transcript permanently. The inconsistency with `transcript_chunks_delete` also suggests this was an oversight.

**Blast radius:**  
Targeted transcript corruption on any meeting an editor has access to. No audio is affected, but the displayed transcript and RAG context are degraded.

**Proposed fix:**  
Remove `can_access_meeting(meeting_id, 'editor')` from `transcript_segments_delete`. Match the `transcript_chunks_delete` pattern (owner/admin only).

**Two-sided test:**
- Meeting owner → can delete segments (via cascade, not direct — but policy permits)
- Shared editor → cannot delete segments via direct REST call

---

### FINDING-4 · MEDIUM · `admin_config` SELECT RLS exposes encrypted key material to admin JWT callers

**Table:** `admin_config`

**Current policy:**
```sql
CREATE POLICY "admin_read_admin_config"
  ON admin_config FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');
```

No column restriction. The table includes `value_ciphertext`, `value_iv`, `value_auth_tag`.

**Why it's a problem:**  
An admin using the Supabase REST API (`/rest/v1/admin_config?select=*`) with the anon key and admin JWT can read all three ciphertext columns for every stored provider API key. The CLAUDE.md security contract says: *"key_ciphertext, key_iv, key_auth_tag are NEVER returned in any API response, ever."* The admin API routes honour this (they use service-role and return only masked shapes), but the direct REST path bypasses those routes.

An attacker who steals an admin JWT can exfiltrate the ciphertext. Decryption requires `KEY_ENCRYPTION_SECRET` (server-only env var), so standalone it yields nothing — but if that env var is also compromised, all stored API keys are exposed.

**Blast radius:**  
Encrypted API key material exposed to any admin session token. A second compromise of `KEY_ENCRYPTION_SECRET` would decrypt all keys.

**Proposed fix (option A — column-level privilege):**
```sql
REVOKE SELECT (value_ciphertext, value_iv, value_auth_tag) ON admin_config FROM authenticated;
```
This prevents any authenticated role (anon key + JWT) from reading those columns. The service role (which reads them for decryption) is unaffected.

**Proposed fix (option B — view):**  
Create a `admin_config_masked` view that excludes the ciphertext columns and grant SELECT on the view. Redirect the admin RLS policy to the view. Service-role code continues to query the base table.

Option A is simpler and immediately effective.

**Two-sided test:**
- Service-role `getActiveKeys()` → still reads ciphertext columns (service role bypasses column privilege)
- Admin REST call `/rest/v1/admin_config?select=*` → ciphertext columns omitted or error

---

### FINDING-5 · MEDIUM · `can_access_meeting` SECURITY DEFINER function granted to `anon` role

**Function:** `public.can_access_meeting(p_meeting_id uuid, p_min_role text)`

**Current grants (migration 012):**
```sql
GRANT EXECUTE ON FUNCTION public.can_access_meeting TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_meeting TO anon;   -- ← unnecessary
```

**Why it's a problem:**  
`can_access_meeting` is declared `SECURITY DEFINER`, meaning it runs with DB owner (superuser) privileges regardless of who calls it. The function queries `meetings`, `folders`, and `folder_shares` tables, bypassing RLS internally — this is necessary and correct when called *within* an RLS policy.

However, the `anon` grant allows unauthenticated callers to invoke this SECURITY DEFINER function via the Supabase RPC endpoint (`/rest/v1/rpc/can_access_meeting`). Since `auth.uid()` returns NULL for anon callers, the function always returns FALSE (no meeting is accessible to a NULL user), so there is no immediate data leakage. But:

1. The function is callable by anyone without authentication — unnecessary for a SECURITY DEFINER function.
2. Future modifications to the function could inadvertently expose data to anon callers.
3. Principle of least privilege: anon users have no legitimate reason to call this function.

**Blast radius:**  
Currently: none (returns FALSE for all anon calls). Potential future regression risk.

**Proposed fix:**
```sql
REVOKE EXECUTE ON FUNCTION public.can_access_meeting FROM anon;
```

The `authenticated` grant remains, ensuring the function continues to work in RLS policies evaluated under authenticated sessions.

**Two-sided test:**
- Authenticated user (viewer) calls `can_access_meeting` on their accessible meeting → TRUE
- Unauthenticated RPC call → 401 or permission denied

---

### FINDING-6 · LOW · `match_transcript_chunks` callable by PUBLIC (default PostgreSQL grant)

**Function:** `public.match_transcript_chunks`

**Current state:**  
No explicit GRANT or REVOKE in schema.sql. PostgreSQL defaults: functions are executable by PUBLIC (which includes anon).

**Why it is NOT a security bug right now:**  
`match_transcript_chunks` is NOT SECURITY DEFINER — it runs with the caller's privileges. An anon caller has no JWT → `auth.uid()` = NULL → `transcript_chunks_select` RLS denies all rows → function returns an empty set. No data leakage.

**Proposed fix (defense-in-depth):**
```sql
REVOKE EXECUTE ON FUNCTION public.match_transcript_chunks FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.match_transcript_chunks TO authenticated;
```

**Two-sided test:**
- Authenticated user calls RPC with valid JWT → retrieves their accessible chunks
- Unauthenticated RPC call → 401 or empty result

---

### FINDING-7 · LOW · `quota_ledger` hard-delete cascade loses billing history

**Table:** `quota_ledger`

**Current:** `user_id REFERENCES auth.users(id) ON DELETE CASCADE`

**Why it matters:**  
When an admin deletes a user via `DELETE /api/admin/users/:id`, all ledger rows are deleted. If quota is ever used for billing reconciliation, the history is gone. The same applies to `quota_wallets`.

**Blast radius:**  
Loss of quota/billing audit trail when a user is deleted.

**This is a retention/compliance design decision, not a bug.** Document here so it is explicitly decided before any paid tier launches. Options: `ON DELETE SET NULL` with a tombstone flag, or archiving to a separate table before deletion.

**Proposed action:** Decide retention policy before any billing launch. No migration needed until then.

---

### FINDING-8 · LOW · `jobs` SELECT excludes shared-folder members

**Table:** `jobs`

**Current policy:**
```sql
CREATE POLICY "users_read_own_jobs"
  ON public.jobs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.meetings m
       WHERE m.id = jobs.meeting_id
         AND m.user_id = auth.uid()        -- meeting owner only, not shared members
    )
  );
```

**Why it matters:**  
A shared viewer waiting for a meeting to process (status = 'processing') cannot observe job step progress via the `jobs` table. They can poll `meetings.status` instead — which is the primary UI mechanism. No security concern; documented for completeness.

**No action required** unless a future feature exposes job step granularity to shared members.

---

## 4. Checks That Passed

The following audit checkpoints showed correct behavior — no finding raised.

| Checkpoint | Result |
|---|---|
| **Role source** | All policies use `auth.jwt()->>'user_role'` (from `app_metadata` via hook). No policy uses `user_metadata`. ✓ |
| **JWT hook security** | Migration 002 revokes `public.custom_access_token_hook` from `authenticated`, `anon`, `public`. Only `supabase_auth_admin` retains EXECUTE. ✓ |
| **`quota_apply_movement` EXECUTE grant** | No GRANT to `authenticated` or `anon`. Only callable via service-role client. `search_path` locked to `public`. ✓ |
| **`claim_next_job` EXECUTE grant** | No explicit GRANT; default is superuser/owner only. Not callable via anon key. ✓ |
| **Share-grant write restriction** | `folder_owner_manage_shares` policy verifies `folders.user_id = auth.uid()` on ALL verbs. The API route also enforces `folder.user_id !== caller.id`. Grantees have SELECT only. ✓ |
| **Audio signed URL gate** | `GET /api/audio-url/:id` enforces `checkMeetingAccess(viewer+)` before minting any URL. Shared viewers can play audio; non-grantees get 403. ✓ |
| **ICS download gate** | `GET /api/calendar-suggestions/:id/ics` enforces `checkMeetingAccess(viewer+)`. ✓ |
| **RAG cross-meeting retrieval** | `lib/rag/retrieve.ts` always uses the user-scoped client (JWT attached). `match_transcript_chunks` is NOT SECURITY DEFINER; RLS on `transcript_chunks` enforces `ACCESS_PREDICATE`. A user cannot retrieve chunks from meetings they cannot access. ✓ |
| **`prevent_role_escalation` trigger** | Reads `current_setting('request.jwt.claims')` — null for service-role → allows admin ops. Non-null + non-admin → raises exception. Belt-and-suspenders correct. ✓ |
| **Column-level privilege on `profiles`** | `REVOKE UPDATE ON profiles FROM authenticated; GRANT UPDATE (username, display_name, avatar_key, theme_preference) TO authenticated`. Role column excluded. ✓ |
| **Folder delete → SET NULL on meetings** | `folder_id ON DELETE SET NULL` — meetings survive folder deletion. Folder share rows cascade-delete, immediately revoking all grantee access. ✓ |
| **Share revocation is immediate** | Deleting a `folder_shares` row immediately removes the grantee from `can_access_meeting`. No cache layer. ✓ |
| **Chat sessions are personal** | `chat_sessions` scoped to `user_id = auth.uid()`. Each user gets their own session row even for shared meetings. ✓ |

---

## 5. Admin Content Access Decision (ADMIN_CONTENT_ACCESS)

**This is a policy decision for you to confirm, not a bug.**

**Current behavior:** Admins have full RLS-level read/write/delete access to all users' meeting content (transcripts, notes, summaries, todos, chat history).

**BRD intent:** `ADMIN_CONTENT_ACCESS = manage_accounts_only` → admins manage accounts but cannot read other users' meeting content.

**Impact of choosing `manage_accounts_only` (implement FINDING-1 fix):**
- Admin REST API calls on content tables return no rows (or 403) for other users' data
- Admin pipeline/operational routes are **unaffected** (they use service-role client, bypass RLS)
- Admin billing/usage routes are **unaffected** (usage_log, audit_logs retain admin SELECT)
- Admin UI (`/admin/pipeline`, `/admin/users`) is **unaffected** (routes use service-role)
- Adds a clear privacy boundary: admins can see account status but not what was said in meetings

**Impact of choosing `full_content_access` (keep current state):**
- Admins can audit meeting content for abuse, compliance, support escalation
- Higher trust requirement for admin credentials
- Must be documented as an explicit privacy policy choice

**Please confirm which option to implement before Phase 3.**

---

## 6. Proposed Remediation Order

| Priority | Finding | Migration | API Route | Two-sided Test |
|---|---|---|---|---|
| 1 | FINDING-2: Editor meeting delete | `022_rls_meeting_delete_owner_only.sql` | `app/api/meetings/[id]/route.ts` | editor DELETE → 403 |
| 2 | FINDING-3: transcript_segments editor delete | `022_rls_meeting_delete_owner_only.sql` (same) | none | editor REST DELETE on segment → 403 |
| 3 | FINDING-4: admin_config ciphertext | `023_rls_admin_config_column_privilege.sql` | none (column-level revoke) | admin REST `select=*` → ciphertext absent |
| 4 | FINDING-5: can_access_meeting anon grant | `024_rls_function_grants.sql` | none | anon RPC call → permission denied |
| 5 | FINDING-6: match_transcript_chunks public | `024_rls_function_grants.sql` (same) | none | anon RPC → 401/denied |
| 6 | FINDING-1: Admin content bypass | `025_rls_admin_content_access.sql` | none (policy-only) | admin JWT REST on content → 0 rows |

Items 1–5 are unambiguous correctness fixes and can proceed immediately. Item 6 requires the policy decision in Section 5 first.

Each migration is small and individually rollback-able. Migrations 022–024 do not touch the service-role path and do not affect the existing admin operational surfaces.

---

## 7. Phase 2 Discussion Points

When walking through this report:

1. **FINDING-2 (editor delete)** — should editors be able to delete at all? Suggest restricting to rename/move only.
2. **FINDING-3 (transcript_segments delete)** — clearly an oversight vs transcript_chunks. No content discussion needed.
3. **FINDING-4 (ciphertext)** — column-level REVOKE is a one-liner; low risk. Confirm option A (revoke on column) vs option B (view).
4. **FINDING-5 + 6 (function grants)** — housekeeping; bundle into one migration.
5. **FINDING-1 + Section 5** — the big policy decision. Needs explicit confirmation.
6. **FINDING-7 (ledger cascade)** — flag for the billing roadmap; no action now.
