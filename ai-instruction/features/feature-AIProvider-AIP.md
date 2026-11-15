# AI Provider Abstraction Module (AIP)

**Module prefix:** AIP  
**Status:** ❌ Not started — planning artifact only; no application code or migrations yet  
**Priority:** Required before multi-provider offering; blocks AIP-02+ until AIP-01 lands  
**Key files:** TBD (will span `lib/gemini/`, `lib/openai/`, `lib/providers/`, `lib/keys/provider.ts`, `app/api/chat/route.ts`, `lib/pipeline/processMeeting.ts`)

---

## Overview

The AI Provider Abstraction module introduces a **thin provider interface** that sits between the application and any AI model used for *generation*. "Generation" means exactly two things in this codebase:

1. **Meeting analysis** — producing transcript segments, summary, notes, todos, and calendar suggestions from a Speechmatics transcript.
2. **RAG answer synthesis** — grounding an answer in retrieved transcript chunks and returning it with citations.

Everything else stays pinned to its current provider:

- **Embeddings → always Gemini.** Vectors from different providers are not dimension-compatible; the `transcript_chunks` table holds `vector(768)` with an HNSW index built for Gemini's `gemini-embedding-001` output. Anthropic has no embeddings API. Retrieval therefore always runs on Gemini regardless of a meeting's generation model.
- **Speech-to-text → always Speechmatics.** AI providers analyze only the text transcript that Speechmatics produces; they never receive audio directly.

### What the abstraction provides

A single `ProviderAdapter` interface (`generateStructured` + `generateText`) replaces every direct Gemini SDK call in the generation paths. A registry maps `(provider, model)` pairs to adapters and capability flags. The first adapter refactors the existing Gemini code with **zero behavior change**; the second (OpenAI) proves the abstraction and serves as the reusable shape for future OpenAI-compatible providers.

### What the abstraction deliberately does NOT change

- **Quota enforcement stays flat.** 1 agent-query = 1 unit for any provider/model. Audio-minute deductions are Speechmatics duration (already provider-independent). Token volume across providers is **telemetry/reporting only** via `usage_log` (which already stores `provider + model + tokens`) — it does not gate quota. Token-based quota (per-model pricing) is deferred to COM-03.
- **Fallback scope.** Within-provider fallback (e.g., Flash → Flash-Lite) works automatically via the key pool's existing error handling. Cross-provider fallback (e.g., Gemini → OpenAI on failure) only activates if an admin explicitly enables it, because it breaks the "user chose model X" contract and risks schema-compliance drift across adapter implementations.

### Scoping note on SEC-04 / key pool

CLAUDE.md §9f describes a `provider_keys` table (migration 014). That table was **superseded** by migration 015, which replaced it with the generic `admin_config` table. The live key pool is `admin_config` + `lib/keys/provider.ts`. AIP-05 generalizes **that** system — it does not build a parallel one.

---

## Features

### AIP-01 — Provider interface + registry
**Status:** ✅ Done
**Key files:** `lib/ai/types.ts`, `lib/ai/registry.ts`, `lib/ai/adapters/gemini.ts`, `lib/gemini/analyze.ts` (modified), `lib/gemini/answer.ts` (modified)

**User Story**  
As a developer, I want a single thin interface over AI generation so any meeting-analysis or RAG-answer call can be routed to a different model without changing the callers.

**Use Cases**
1. A caller invokes `generateStructured(prompt, jsonSchema, opts)` or `generateText(prompt, opts)`. It has no knowledge of which SDK or model handles the call.
2. The registry resolves `(provider, model)` → the correct adapter instance. Adapters are the only place that touch any provider SDK.
3. The registry also exposes capability flags per `(provider, model)` — e.g. `acceptsAudio: boolean`, `hardJsonSchema: boolean`, `maxContextTokens: number`. Callers use these flags where behavior must branch.
4. All existing Gemini calls in `lib/gemini/analyze.ts` and `lib/gemini/answer.ts` are refactored to go through the interface. Externally observable behavior is identical; tests must remain green.
5. No model name is hard-coded outside the registry and adapter implementations. `GEMINI_MODEL` in `lib/gemini/client.ts` becomes a registry entry, not a module constant referenced by callers.

**Frontend**
- None in this feature; the abstraction is purely server-side.

**Backend** *(describe only — implementation deferred)*
- `ProviderAdapter` interface: `generateStructured<T>(prompt: string, schema: JsonSchema, opts: GenerateOpts): Promise<T>` and `generateText(prompt: string, opts: GenerateOpts): Promise<string>`. Both accept `opts.keyId` (for usage attribution) and `opts.ctx` (meetingId, userId for telemetry).
- `ProviderRegistry` singleton: maps `provider: string` × `model: string` → `{ adapter: ProviderAdapter; caps: CapabilityFlags }`. Initialized at module load; individual adapters are lazy-constructed.
- `CapabilityFlags`: `hardJsonSchema: boolean` (Gemini responseSchema / OpenAI json_schema → true; Claude tool_use → false), `maxContextTokens: number`, `acceptsAudio: boolean` (false for all generation-path providers; audio stays with Speechmatics).
- First adapter: `GeminiAdapter` wraps the existing `geminiPool.call()` + JSON retry logic from `analyze.ts`. The retry-with-stricter-prompt behavior (currently in `analyze.ts`) moves inside the adapter so it stays consistent regardless of caller.
- The existing `generateText()` helper in `lib/gemini/client.ts` becomes `GeminiAdapter.generateText()`.
- `lib/gemini/pool.ts` and `lib/keys/provider.ts` are untouched in this feature (they are generalized in AIP-05).

---

### AIP-02 — OpenAI adapter
**Status:** ❌ Not started

**User Story**  
As a developer, I want an OpenAI adapter so I can run meeting analysis and RAG answers on GPT models, proving the abstraction works with a second provider.

**Use Cases**
1. An admin configures an OpenAI API key (via the key pool, see AIP-05) and selects an OpenAI model as the system default or a per-user option (see AIP-06).
2. A new meeting is processed with the OpenAI adapter. The same transcript + structured-output schema are sent; the adapter returns the same JSON shape as the Gemini adapter.
3. A RAG question on a meeting processed by OpenAI uses the OpenAI adapter for answer synthesis. Retrieval (embedding + RPC) is unchanged — still Gemini.
4. A meeting processed by Gemini is never re-processed through OpenAI: the per-meeting lock (AIP-03) prevents this.

**Frontend**
- None specific to this feature; the model picker (AIP-06) exposes the registered models.

**Backend** *(describe only)*
- `OpenAIAdapter` implements the `ProviderAdapter` interface using the OpenAI Node SDK's `chat.completions.create` with `response_format: { type: 'json_schema', json_schema: { ... } }` (OpenAI Structured Outputs — hard JSON schema, not a hint).
- Capability flags: `hardJsonSchema: true`, `acceptsAudio: false`, `maxContextTokens` varies by model.
- **OpenAI-compatible shape:** the adapter is parameterized by `baseUrl + apiKey + model`, making it reusable for future OpenAI-compatible providers (future GPT variants, Grok, Kimi) with zero adapter code changes — only a registry entry + key pool entry is needed. This is the intended reuse path.
- **Claude compatibility note (future, not in scope):** Anthropic's Claude API uses a tool-use pattern for structured output (no native `json_schema` mode). A `ClaudeAdapter` would need its own implementation; it is not included in this phase.
- Key rotation and cooldown for OpenAI follow the same pattern as the Gemini pool (AIP-05): 429 → exponential backoff + key rotation; 401 → permanent disable.

---

### AIP-03 — Per-meeting model lock
**Status:** ❌ Not started

**User Story**  
As the system, I want every meeting to record which provider and model generated its content so that future analysis re-runs and single-meeting RAG always use the same model that produced the original content.

**Use Cases**
1. A user triggers generation (record or upload). The system resolves the model from the control plane (AIP-06: PRF-08 pref → ADM-10 system default) and writes it into the meeting row before calling the pipeline.
2. All three generation calls for that meeting — analysis, any re-gen of summary/notes, and single-meeting RAG answer — read the locked `(generation_provider, generation_model)` from the meeting row and use that adapter. No caller infers or guesses the model.
3. **Legacy meetings** (no `generation_provider` value): a one-time backfill sets `generation_provider = 'gemini'`, `generation_model = 'gemini-2.5-flash'` for all existing rows, so the lock is defined for all data.
4. A re-queue of a failed or stuck meeting (pipeline monitor, ADM-04) reuses the locked model — it does not re-resolve the control plane.

**Frontend**
- The meeting detail page (and admin pipeline monitor) may optionally display the locked model as metadata (read-only). Not required for MVP of this feature.

**Backend** *(describe only)*
- **Migration:** add `generation_provider text NULL` and `generation_model text NULL` to `meetings`; add a `CHECK (generation_provider IS NULL) = (generation_model IS NULL)` constraint (both set or both null); backfill all existing rows to `('gemini', 'gemini-2.5-flash')`.
- **Lock write:** `processMeeting.ts` writes `generation_provider` + `generation_model` into the `meetings` row at the start of pipeline execution (before the Speechmatics call), not at trigger time, to avoid a race between trigger and the first pipeline step.
- **Lock read:** `analyzeTranscript()` and `answerWithContext()` receive the locked pair from the meeting row (passed via `usageCtx` or a new `modelCtx` argument) and resolve the adapter from the registry. They no longer use the `GEMINI_MODEL` constant directly.
- **Single-meeting RAG enforcement:** `app/api/chat/route.ts` fetches `generation_provider + generation_model` from the meeting row and passes them to `answerWithContext()` when `meetingId` is set.

---

### AIP-04 — Cross-meeting RAG model rule
**Status:** ❌ Not started

**User Story**  
As the system, I want a defined policy for which model answers cross-meeting questions (global and folder-scoped RAG) so the answer model is predictable even when retrieved chunks come from meetings with different locked models.

**Use Cases**
1. A user asks a question in global RAG (`/chat`) or folder-scoped RAG (RAG-04). The answer spans chunks from multiple meetings, each potentially locked to a different model. The per-meeting lock (AIP-03) cannot apply here.
2. The system resolves the answer model from the cross-meeting policy and routes the `answerWithContext()` call to that adapter.
3. Retrieval (embedding + `match_transcript_chunks` RPC) is always Gemini, unchanged.

**Open design question — three options, recommended default documented:**

| Option | Description | Trade-off |
|---|---|---|
| ✅ **Recommended: system default (ADM-10)** | Use the admin-configured system default model for all cross-meeting answers. | Predictable, question-independent, easy to explain. Changes when admin changes the default. |
| Alternative: caller's PRF-08 pref | Use the asker's personal model preference. | Personalised but inconsistent — different users get different answer quality for the same shared folder. |
| Rejected: model of meeting contributing most chunks | Choose the answer model based on which meeting contributed the most retrieved chunks. | Non-deterministic across re-phrasings; computationally awkward; breaks expectations. |

*The recommended default (system default via ADM-10) will be implemented unless explicitly overridden before AIP-04 ships.*

**Frontend**
- None required; the model choice is transparent to the user.

**Backend** *(describe only)*
- `app/api/chat/route.ts`: when `folderId` is set or neither `meetingId` nor `folderId` is set (global scope), fetch the cross-meeting answer model from the ADM-10 system config and resolve the adapter from the registry.
- `answerWithContext()` receives a `modelCtx: { provider, model }` argument (replacing the implicit Gemini assumption) and uses the registry to select the adapter. No other change to the answer logic.
- Retrieval path (`lib/rag/retrieve.ts`, `embedChunks`, `match_transcript_chunks`) is untouched.

---

### AIP-05 — Provider-aware key pool
**Status:** ❌ Not started

**User Story**  
As an admin, I want to manage API keys for Gemini, OpenAI, and Speechmatics in one place, with per-key rotation, cooldown, and load-balancing, so I can operate any registered provider without manual intervention.

**Use Cases**
1. Admin adds an OpenAI key via `/admin/keys` (the existing UI). The key is stored encrypted in `admin_config` with `config_key = 'openai_api_key'`.
2. A generation call routes through an `OpenAIKeyPool` that loads OpenAI keys from `admin_config`, rotates on 429/5xx, and disables on 401 — mirroring `GeminiKeyPool` exactly.
3. **Speechmatics load-balancing (distinct from failover):** Speechmatics transcription jobs are long-running (minutes), and multiple jobs can run concurrently. Multiple Speechmatics keys are load-balanced across concurrent jobs (round-robin or least-recently-used) rather than failing over only on error. A key is used again once its active job completes or times out. This is different from the Gemini and OpenAI patterns, which are stateless per-request rotation.
4. Rotation and cooldown behavior is encapsulated in a shared `KeyPool` base class (or a parameterized factory) so `GeminiKeyPool` and `OpenAIKeyPool` share the retry/cooldown logic; only the client construction differs.
5. The `/admin/keys` UI already renders all `admin_config` rows; adding `config_key = 'openai_api_key'` entries makes them appear automatically. No UI changes needed in this feature.
6. `invalidateKeyCache(provider?)` in `lib/keys/provider.ts` is provider-scoped and already works for any `config_key` pattern; no change needed to the cache-invalidation path.

**Frontend**
- None beyond what the existing `/admin/keys` UI already provides. OpenAI keys appear automatically under their label once added.

**Backend** *(describe only)*
- `lib/keys/provider.ts`: add `'openai'` to the recognized provider set; map it to `config_key = 'openai_api_key'`; env fallback reads `OPENAI_API_KEY`.
- `GeminiKeyPool` in `lib/gemini/pool.ts` is extracted into a generic `KeyPool<Client>` base class parameterized on the SDK client type and a factory function. `GeminiKeyPool` becomes `new KeyPool(buildGeminiClient, 'gemini', opts)`.
- `OpenAIKeyPool` = `new KeyPool(buildOpenAIClient, 'openai', opts)`.
- Speechmatics: a `SpeechmaticsKeyPool` with a long-running-job-aware selection strategy (least-active-key, not LRU). Each key tracks the count of in-flight jobs; the pool picks the key with the lowest count. On job completion or timeout, the count is decremented.
- All pools are initialized lazily (same 30-second TTL pattern as the current `GeminiKeyPool`).

---

### AIP-06 — Control plane
**Status:** ❌ Not started

**User Story**  
As an admin, I want to configure a provider/model allow-list and a system default; as a user, I want to set my own default model for new meetings; as a recorder, I want to pick a model at the point of recording or uploading.

**Use Cases**
1. Admin configures the allowed provider/model set via ADM-10 (runtime config). The allow-list is read from `admin_config` rows; the registry (AIP-01) is the authoritative source of all supported models — ADM-10 only gates which subset is permitted for this deployment.
2. Admin sets the system-default `(provider, model)` in ADM-10. This is the fallback when no user preference is set and the per-meeting default for cross-meeting RAG (AIP-04).
3. A user sets their personal default model (PRF-08) at `/profile/settings`. The model must be in the admin allow-list; the server rejects values outside it.
4. When a user starts a recording or uploads a file, a model picker (optional, pre-filled with their PRF-08 pref) lets them choose the model for this specific meeting. On confirm, the chosen `(provider, model)` is passed to the generation trigger; `processMeeting.ts` writes it into the meeting lock (AIP-03).
5. **Fallback chain for new meetings:** user pick (if present) → PRF-08 personal default → ADM-10 system default. The first defined value wins.

**Frontend**
- ADM-10 admin surface: a provider/model configuration panel in `/admin` (or `/admin/config`) — allow-list checkboxes from the registry, system-default picker.
- PRF-08 user surface: a model-preference selector at `/profile/settings` — dropdown limited to the admin allow-list.
- Record/upload surface: an optional model picker shown before confirming; pre-populated with the user's PRF-08 pref. Omitting a pick applies the fallback chain silently.

**Backend** *(describe only)*
- ADM-10 implementation: admin config rows in `admin_config` for `system_default_provider`, `system_default_model`, and `allowed_providers_models` (JSON array of `{ provider, model }` pairs).
- PRF-08 implementation: `default_provider` and `default_model` columns on `profiles` (nullable; null = "use system default"). `PATCH /api/profile/preferences` validates the chosen model is in the ADM-10 allow-list before writing.
- `resolveGenerationModel(userId)`: a server-side helper that applies the fallback chain, reads from `profiles` and `admin_config`, and returns `{ provider: string; model: string }`. Called by the generation trigger path before writing the meeting lock.
- `processMeeting.ts` receives `{ provider, model }` as an input parameter (rather than reading `GEMINI_MODEL` from a constant) and passes it to the adapter resolver.

---

### AIP-07 — Anthropic Claude provider
**Priority:** Medium | **Status:** ✅ Done

**User Story**  
As an admin, I want to add Anthropic API keys and enable Claude models (Opus 5.5, Sonnet 5.5, Haiku 5.5) so that meeting analysis and chat can run on Claude, and I can make one of them the system default.

**Context**
v2 runs generation on Gemini, OpenAI and Grok only; the AI layer (ARC-08c) was designed for this: one adapter per API kind (`complete_json`, used by both analysis and chat), a catalog of providers/models, key pools per provider, allow-list + system default in admin settings (AIP-06). Owner decision 2026-11-15: option A, the provider only, for analysis + chat, all three current Claude models; prompt caching, effort tuning and refusal fallbacks are deferred (option B, not chosen). Embeddings stay on Gemini (768-dim, CLAUDE.md §0.7; Anthropic has no embeddings API).

**Use Cases**
1. Admin adds an Anthropic key at /admin/keys; the key check passes.
2. Admin allows Claude Sonnet 5.5 at /admin/config and sets it as the system default; new meetings are analysed by it.
3. A user picks Claude Opus 5.5 for one meeting or as their personal default; chat on that meeting answers through Claude.

**Frontend**
- `anthropic` (label "Anthropic") in the key provider lists (`lib/admin/config.ts` KEY_PROVIDERS, `AdminKeysPage` known names) and the usage provider list (`AdminUsagePage`, `lib/admin/ops.ts`); EN/VI strings.
- Model pickers need no change (they list the catalog / allowed models).

**Backend**
- `app/services/ai/adapters/anthropic.py`: `AnthropicAdapter.complete_json` via the official `anthropic` Python SDK (`AsyncAnthropic(api_key=key, max_retries=0)`: retries/rotation stay in the key pool), JSON through structured outputs (`output_config.format` with a JSON schema converted from the neutral schema), `max_tokens` sized for the analysis output, refusal (`stop_reason == "refusal"`) → `ModelRefused`, SDK status errors → `ProviderHTTPError(status, code, retry_after)`, connection/timeouts → `ProviderTransportError`, usage tokens → `Completion`.
- `catalog.py`: `ProviderInfo("anthropic", "anthropic", "https://api.anthropic.com", "Anthropic")` + `ModelInfo` for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; `ADAPTERS["anthropic"]`.
- `keys/source.py`: `"anthropic": "anthropic_api_key"` (+ `ANTHROPIC_API_KEY` env fallback, same rule as other providers); key health check for Anthropic via the Models API.
- `pyproject.toml` / `uv.lock`: add `anthropic`.

**Acceptance Criteria**
- Given a neutral `JsonRequest`, when the adapter builds the Anthropic request, then model, system, user message and a strict JSON schema (`additionalProperties: false`, all `required`) are set, and no prefill/sampling params are sent.
- Given a response with a text block of valid JSON and usage, when parsed, then `Completion.text` is that JSON and input/output/total tokens are filled.
- Given `stop_reason == "refusal"`, when parsed, then `ModelRefused` is raised (no retry on another key); given 429 with `retry-after`, then `ProviderHTTPError(429, retry_after=…)`; given 401, then `ProviderHTTPError(401)` (key disabled by the pool).
- Given an admin adds an `anthropic` key at /admin/keys, then it is stored encrypted, shown with its last 4, and the key check reports healthy for a valid key.
- Given Claude Sonnet 5.5 is allowed and set as system default, when a meeting is analysed, then `meetings.generation_provider = 'anthropic'`, the summary is produced and a `usage_log` row with provider `anthropic` is written.
- Embeddings for that meeting are still produced by Gemini.

**Test Plan**
- Pure logic: `app/api/app/services/ai/adapters/anthropic.py` → `build_request(req) -> dict`, `parse_message(message) -> Completion` (raises `ModelRefused`), `to_anthropic_schema(neutral) -> dict`, error mapping `provider_error(exc)`.
- Tests: `app/api/tests/test_ai_anthropic_adapter.py` (request shape, schema conversion, parsing, refusal, 401/429/5xx/transport mapping); `test_ai_catalog_schema.py` / `test_catalog_diff.py` updated for the new provider + models; web `lib/admin/config` test if the provider list is tested.

**Structural flags**
- New provider + new dependency `anthropic` (official SDK). No migration; optional env `ANTHROPIC_API_KEY`.

**Done check**
- `cd app/api && uv run pytest -q` green; then in production: add an Anthropic key at /admin/keys (healthy), allow + pick Claude Haiku 5.5 for a short test meeting, and see the summary and a chat answer.

**Out of scope**
- Prompt caching, per-task effort setting, server-side refusal fallbacks (option B); Claude for transcription or embeddings; prompt retuning for Claude.

**Key files**
- `app/api/app/services/ai/adapters/anthropic.py`, `app/api/app/services/ai/catalog.py`, `app/api/app/services/ai/service.py`, `app/api/app/worker/tasks/keyhealth.py` (probe `GET /v1/models`; `keys/source.py` needed no change: `anthropic_api_key` / `ANTHROPIC_API_KEY` by convention), `app/api/pyproject.toml`, `app/api/tests/test_ai_anthropic_adapter.py`, `app/web/src/lib/admin/config.ts`, `app/web/src/routes/admin/AdminKeysPage.tsx`, `app/web/src/routes/admin/AdminUsagePage.tsx`, `app/web/src/lib/admin/ops.ts`, `app/web/src/i18n/locales/*`

---

## Key Constraints & Design Decisions

- **Scope of the abstraction:** multi-provider applies to GENERATION only (meeting analysis + RAG answer synthesis). Not embeddings, not speech-to-text.
- **Embeddings pinned to Gemini permanently:** `transcript_chunks` is `vector(768)` with an HNSW index; reindexing for a different dimension would be a breaking migration. Gemini is the only supported embeddings provider.
- **One model per meeting:** the `(generation_provider, generation_model)` pair is chosen once at generation trigger and frozen. Re-gen, re-queue, and single-meeting RAG all use the locked model.
- **Legacy rows backfilled to Gemini:** all meetings without a `generation_provider` value are treated as `('gemini', 'gemini-2.5-flash')` via a one-time migration backfill.
- **Cross-meeting RAG:** uses system default (ADM-10). This is an open design question; the recommended answer is ADM-10 default (predictable, question-independent). See AIP-04 for alternatives.
- **Quota unchanged:** flat unit (1 agent-query, audio-seconds). Token volume is telemetry only. No per-model pricing in quota enforcement.
- **Cross-provider fallback off by default:** cross-provider failover (Gemini → OpenAI on error) requires explicit admin enable because it breaks the per-meeting model contract and risks schema-compliance drift.
- **OpenAI-compatible shape as reuse path:** future OpenAI-compatible providers (GPT variants, Grok, Kimi) reuse the `OpenAIAdapter` parameterized by base URL + key + model. A Claude adapter would need separate implementation (tool_use, no native json_schema mode).
- **Key pool live system:** `admin_config` table (migration 015) is the live key store, not the superseded `provider_keys` table (migration 014). AIP-05 extends `admin_config` and `lib/keys/provider.ts`.

---

## Build Order

1. **AIP-01** — Provider interface + registry + GeminiAdapter refactor. Every other AIP feature depends on this.
2. **AIP-03** — Per-meeting model lock (migration + backfill + lock write/read). Requires AIP-01; makes the model observable per meeting before adding new providers.
3. **AIP-02** — OpenAI adapter. Requires AIP-01 (interface) and AIP-05 (key pool) to be usable end-to-end.
4. **AIP-05** — Provider-aware key pool. Can be developed in parallel with AIP-02 (they land together).
5. **AIP-06** — Control plane (ADM-10 + PRF-08 + model picker). Requires AIP-01 + AIP-03; makes the model choice user/admin-configurable.
6. **AIP-04** — Cross-meeting RAG model rule. Requires AIP-03 + AIP-06 (system default read path). Simplest implementation; lands last.

---

## Dependencies

- **AIP-01 depends on:** PRP-03/04/05 (meeting analysis pipeline), `lib/gemini/analyze.ts`, `lib/gemini/answer.ts` — these are refactored in-place.
- **AIP-02 depends on:** AIP-01 (interface + registry), AIP-05 (OpenAI key pool).
- **AIP-03 depends on:** AIP-01 (adapter resolver), `meetings` schema (new columns + migration).
- **AIP-04 depends on:** AIP-03 (per-meeting lock, to contrast with cross-meeting), RAG-01 (global chat), RAG-04 (folder-scoped chat), AIP-06 (system default read path).
- **AIP-05 depends on:** SEC-04 — specifically `admin_config` + `lib/keys/provider.ts` (generalizes, does not replace). Affects Speechmatics (REC-05 / QUO-02) and all generation paths (QUO-03).
- **AIP-06 depends on:** AIP-01 (registry as model catalog), AIP-03 (lock write), ADM-10 planning (this is its first implementation), PRF-08 planning (also its first implementation).
- **Related (not a dependency):** COM-03 (SaaS billing) — per-model pricing would extend the flat quota model established by QUO; AIP makes the provider/model observable so that extension is possible.
