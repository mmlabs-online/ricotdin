# Cost & Scaling Module (CST)

**Module prefix:** CST  
**Status:** ❌ Not started  
**Priority:** Important before scaling to many users; tied to PRV-03

---

## Overview

The Cost & Scaling module addresses the economics of running the application at scale. The free Supabase tier has a ~1GB Storage cap (hit after roughly 30 hour-long sessions), and Gemini's free tier has strict rate limits. This module provides cost modeling visibility and the infrastructure changes needed to avoid hard limits.

---

## Features

### CST-01 — Cost model
**Status:** ❌ Not started

**User Story**  
As the product owner, I want to compute costs at real scale to understand the economics before scaling.

**Use Cases**
1. Product owner inputs: expected monthly active users, average meetings per user per month, average meeting duration.
2. System outputs: estimated monthly spend on Gemini API (tokens × price per million), Supabase Storage (GB × price), Supabase DB (compute tier needed).
3. Cost model identifies the break-even point between free tier and paid tier.
4. Visible in an admin page or as a documented spreadsheet.

**Key cost drivers (current):**

| Item | Free limit | Paid cost (approx.) |
|---|---|---|
| Supabase Storage | 1 GB total | $0.021/GB |
| Supabase DB | 500 MB | $25/mo (Pro tier) |
| Gemini Flash | 15 RPM / 1500 RPD | $0.10–$0.40 / 1M tokens |
| Gemini Embeddings | Free tier | ~$0.00002 / 1K chars |

**Calculation (rough):**
- 1 hour meeting ≈ 50 MB audio (pre-transcoding) → ~1 MB MP3 after transcoding.
- After 30 hour-long meetings, Supabase free Storage is full.
- Gemini 1500 RPD free tier ≈ ~375 meetings/day (4 calls per meeting: upload, analyze, embed, answer).

**Frontend**
- Optional admin page at `/admin/costs` with input sliders + cost output.
- Or: a documented Markdown file in the repo (`docs/cost-model.md`).

**Backend**
- No server-side implementation required for a static model.
- Dynamic model requires: logging token usage per Gemini call (ADM-05), Storage usage queries (ADM-06).

---

### CST-02 — Audio storage offload
**Status:** ⛔ Superseded (owner 2026-11-19): audio lives on Google Drive (ARC-17), purged by retention (PRV-02).

**User Story**  
As the system, I want to move audio to R2 or purge after processing so I don't hit the storage cap.

**Use Cases**

**Option A — Cloudflare R2 (zero egress cost):**
1. After upload, `processMeeting.ts` moves the file from Supabase Storage to R2.
2. `meetings.audio_path` is updated to an R2 URL.
3. Audio player uses a signed R2 URL instead of a Supabase Storage URL.
4. Supabase Storage usage stays near zero.

**Option B — Purge after processing (simplest):**
1. After `processMeeting()` completes, delete the audio file from Storage.
2. `meetings.audio_path` set to `null`.
3. Audio playback is disabled; users can only view the transcript.
4. Trade-off: users lose the audio player feature.

**Option C — Configurable retention:**
1. Admin sets an audio retention period (e.g., 30 days) in ADM-10 (config & feature flags).
2. A daily cron deletes audio files older than the retention period.
3. Users retain playback for the configured window.

**Recommendation:** Start with Option B (purge) for MVP simplicity, add Option C (configurable retention) as the system matures, and evaluate Option A (R2) if storage costs become significant.

**Frontend**
- Option B: audio player shows "Audio deleted" message with the transcript still accessible.
- Option C: audio player shows "Audio expires in X days" for recent meetings.

**Backend**
- Option A: replace `supabase.storage` calls with AWS S3-compatible R2 client.
- Option B: post-processing cleanup in `processMeeting.ts` (1 extra call to `storage.remove()`).
- Option C: cron job `DELETE FROM storage WHERE age > retention_period` + audio_path nullification.
- Depends on: PRP-01 (audio in storage), MMG-04 (deletion logic), PRV-03 (privacy alignment).

---

## Dependencies

- **CST-01 depends on:** ADM-05 (for dynamic cost tracking) or nothing (for static model)
- **CST-02 depends on:** PRP-01 (storage), MMG-04 (delete flow), PRV-03 (privacy policy alignment)

## Free Tier Hard Limits (quick reference)

| Resource | Limit | Estimated hit point |
|---|---|---|
| Supabase Storage | 1 GB | ~200 × 5MB processed audio files |
| Supabase DB rows | ~500 MB | ~10K meetings with full transcript data |
| Gemini free RPM | 15 requests/min | ~3–4 concurrent processing jobs |
| Gemini free RPD | 1500 requests/day | ~375 meetings/day |
