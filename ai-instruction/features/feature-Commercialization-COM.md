# Commercialization Module (COM)

**Module prefix:** COM  
**Status:** ❌ Not started — SaaS tier only (do not build until commercializing)  
**Priority:** SaaS — required only when selling to external users or businesses

---

## Overview

The Commercialization module contains the legal, billing, consent, and multi-tenancy infrastructure needed to operate the app as a commercial SaaS product. These features are explicitly out of MVP scope and should only be built when the decision to commercialize has been made.

---

## Features

### COM-01 — Recording notice / consent
**Status:** ✅ Done (minimal internal slice, 2026-10-21) — notice modal + `recording_notice_ack` activity event; no `consent_logs` table, no admin toggle  
**Key files:** `components/RecordingNoticeModal.tsx`, `components/RecorderUI.tsx`, `lib/consent/recordingNotice.ts`, `lib/activity/types.ts`, `tests/recording-notice.test.ts`  
**SaaS:** Legal requirement — not optional once serving external users

**User Story**  
As a user, I want an in-app recording notice/consent mechanism to comply with two-party consent laws.

**Use Cases**
1. Before the user starts recording, a modal displays a clear notice: "This app will record and transcribe the meeting. All participants should be aware of and consent to the recording."
2. User must acknowledge the notice (click "I understand — continue") to proceed.
3. Acknowledgement is logged (timestamp, user ID) for compliance purposes.
4. For meetings with external participants: the app provides a suggested verbal notice script ("I'll be recording this meeting for notes...").
5. Admin can configure whether the consent step is mandatory or skippable.

**Why this matters:**  
Two-party (or all-party) consent laws in many US states and countries require all meeting participants to consent to being recorded. Providing an in-app notice mechanism shifts legal responsibility to the user.

**Frontend**
- Consent modal shown before recording starts (on `/record` page).
- User cannot proceed past the modal without clicking "I understand."
- Optionally: consent preference is remembered per session (not forever — the notice should be shown regularly).

**Backend**
- `consent_logs` table: `id, user_id, timestamp, session_id`.
- `POST /api/consent` — logs acknowledgement.
- Admin config (ADM-10): toggle whether consent step is mandatory.
- Depends on: REC-01 (recording start flow).

---

### COM-02 — Legal documents
**Status:** ❌ Not started  
**SaaS:** Required for any commercial deployment

**User Story**  
As the product owner, I want a Privacy Policy, Terms of Service, and DPA to sell legally to businesses.

**Use Cases**
1. `/privacy` — Privacy Policy page: what data is collected, how it's used, retention period, user rights.
2. `/terms` — Terms of Service: acceptable use, liability limits, subscription terms.
3. `/dpa` (or as a downloadable PDF) — Data Processing Agreement: required for B2B customers under GDPR.
4. Footer on all pages links to privacy and terms.
5. Registration page includes "By registering, you agree to our Terms of Service and Privacy Policy."

**Frontend**
- Static pages: `/privacy`, `/terms`, `/dpa`.
- Footer links to both pages.
- Registration form: checkbox "I agree to the Terms of Service and Privacy Policy" (required).

**Backend**
- No API changes; static pages.
- Store user's agreement timestamp: `profiles.terms_accepted_at timestamptz`.
- If ToS is updated, prompt users to re-accept on next login.

---

### COM-03 — Billing / subscription & quota
**Status:** ❌ Not started  
**SaaS:** Required for monetization

**User Story**  
As the product owner, I want billing (Stripe) + per-plan quota management to charge for the service.

**Use Cases**
1. User selects a plan (Free / Pro / Business) at registration or from account settings.
2. Stripe Checkout handles payment; subscription is stored in `subscriptions` table.
3. Each plan has quota limits: meetings/month, max audio duration, storage quota.
4. When a user approaches their quota, a warning banner appears.
5. When quota is exceeded, the upload/process endpoints return 402 Payment Required.
6. Admin can view subscription status and override quotas in ADM-09.

**Frontend**
- Pricing page (`/pricing`) with plan comparison.
- Account settings: current plan, usage vs. quota, upgrade/downgrade buttons.
- Warning banners near quota limits.

**Backend**
- Stripe integration: Checkout, webhooks, Customer Portal.
- `subscriptions` table: `id, user_id, stripe_subscription_id, plan, status, quota_meetings, quota_storage_gb, current_period_end`.
- Quota check middleware injected into `POST /api/meetings` (upload) and `POST /api/meetings/:id/process`.
- Webhook handler: `POST /api/webhooks/stripe` — handles subscription creation, updates, cancellation.
- Depends on: AUT-01 (user accounts).

---

### COM-04 — Multi-tenant data isolation
**Status:** ❌ Not started  
**SaaS:** Required for selling to businesses / teams

**User Story**  
As the product owner, I want strict multi-tenant data isolation to serve many organizations safely.

**Use Cases**
1. Each organization (tenant) has a distinct boundary; users in Org A cannot see Org B's data even if both use the same app.
2. Admin can assign users to organizations.
3. Org-level billing: a single subscription covers all users in the org.
4. Org admin can manage their own users within the tenant.

**Frontend**
- Organization management page (for org admins).
- Org selector if a user belongs to multiple orgs.

**Backend**
- `organizations` table: `id, name, plan, created_at`.
- `organization_members` table: `org_id, user_id, org_role (owner | member)`.
- All data tables get an `org_id` FK; RLS policies add `org_id` scope.
- This is a significant schema change — design carefully before implementing.
- Depends on: AUT-04 (data isolation), COM-03 (billing at org level).

---

### COM-05 — Sharing & collaboration
**Status:** ❌ Not started  
**SaaS:** Near-mandatory to be sellable

**User Story**  
As a user, I want to share meetings and work in a team workspace.

**Use Cases**
1. User shares a meeting with another user in their organization.
2. Shared user can view the transcript, summary, todos — but not delete or re-process.
3. Team workspace: all meetings in an org are visible to org members (with configurable access levels).
4. Meeting owner can set access: private / org-visible / link-shareable.

**Frontend**
- Share button on meeting detail page.
- Org workspace feed (shared meeting list).
- Per-meeting access control UI.

**Backend**
- `meeting_shares` table: `id, meeting_id, shared_with_user_id, can_edit, can_delete`.
- RLS policies updated to allow shared access.
- Link-share: signed public URL with expiry (`meeting_share_links` table).
- Depends on: COM-04 (org structure), AUT-04 (data isolation baseline).

---

## Build Order (if commercializing)

1. COM-01 (consent notice) — legal requirement, low effort; build before any real user launch
2. COM-02 (legal docs) — required for terms acceptance; copy + paste from a template + legal review
3. COM-03 (billing) — core monetization; requires Stripe integration
4. COM-04 (multi-tenancy) — significant schema migration; plan carefully
5. COM-05 (sharing) — highest UX value for teams; depends on COM-04

## Dependencies

- **COM-01 depends on:** REC-01
- **COM-02 depends on:** AUT-01 (registration + terms acceptance)
- **COM-03 depends on:** AUT-01, AUT-04
- **COM-04 depends on:** AUT-04, COM-03
- **COM-05 depends on:** COM-04, AUT-04
