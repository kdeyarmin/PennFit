# Top DME/CPAP Systems — Comparison & PennFit Inbound ePrescribing Plan

## Context

The user asked us to research the top DME/CPAP and inventory systems, identify what makes them best, compare against PennFit, and produce an implementation plan. After research and a comprehensive codebase audit, the user chose to focus the plan on **inbound ePrescribing & referral capture** (with PWA polish) — the single biggest competitive gap and the top revenue-growth lever vs. Brightree/NikoHealth.

---

## Market summary — what makes the leaders "best"

| System                                 | Best-known strength                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brightree** (market leader)          | Deep ResMed AirView integration; automated resupply enrollment on PAP compliance signal; mobile patient app; IVR + live agent voice services; advanced analytics dashboards (days-in-AR, denial rate, on-time delivery) |
| **NikoHealth** (modern challenger)     | Magic-link reorder, native delivery driver app with POD/barcode/route-opt, **Parachute Health integration**, on-demand PECOS verification, flat pricing, robust public API                                              |
| **Bonafide**                           | Lower-cost simpler operations for small providers                                                                                                                                                                       |
| **Parachute Health**                   | Dominant ePrescribing rail: **270k clinicians, 3k DME suppliers**, EHR integrations (Athena, Epic, PointClickCare), 98% first-pass clean-order rate, integrated prior auth                                              |
| **ResMed myAir / Philips DreamMapper** | Patient engagement apps proven to improve PAP compliance ~17 pts vs. AirView/Care Orchestrator alone                                                                                                                    |

**Cross-cutting features that define a "best" DME platform in 2026:** real-time eligibility (270/271), pre-submission claim scrubbing, CMN/PA tracking with payer-rule engine, denial AI (20–30% lower first-pass denials reported), bidirectional ePrescribe with EHR/Parachute, multi-location inventory with par-levels & demand forecasting, mobile driver app with route optimization & POD, configurable KPI dashboards, mobile patient app with push reorder.

## PennFit today (audit summary)

PennFit is **more mature than the typical small-DME stack**. Strong surfaces already in place:

- **Billing/RCM** — eligibility (270/271), 837 claims via Office Ally, ERA ingestion, DaVinci PAS, denial codes, appeals, fee schedules, PA queue (extensive — migrations 0118–0143)
- **Clinical** — ResMed AirView + Philips Care Orchestrator integrations, compliance attestations, PECOS, OIG-LEIE
- **Communications** — SMS/email/voice (Twilio), AI chatbot (Claude Sonnet 4.6), inbound fax + MMS, voice IVR with `gpt-realtime`, 2-way inbox
- **Auth/HIPAA** — argon2id, in-house sessions, HMAC-chained tamper-evident audit log (migration 0116), MFA, BAA tracking, breach incident tracking
- **AI scaffolding** — Claude adapter, intent classification, denial explain/predict, call summarization

Real gaps vs. leaders (in priority order): (1) **inbound ePrescribing / referral capture** is fax-only; (2) multi-warehouse inventory & par-level forecasting; (3) native driver app + route optimization; (4) outcome/cohort dashboards.

**User-chosen scope:** address (1) end-to-end. Stay responsive web (no native apps); finish PWA polish at the end.

---

## Implementation plan — Inbound ePrescribing & Referral Capture

A 6-phase roadmap, each phase ~3–4 weeks (~24 weeks total). Each phase ships independently.

### Key existing patterns to reuse

- **Webhook intake (already mounted):** `artifacts/resupply-api/src/routes/integrations-inbound.ts` already has `parachute` in `SUPPORTED_SOURCES` and lands raw payloads into `resupply.inbound_webhooks` (migration `0138_phase_6_payments_and_inbound.sql`). **No dispatcher yet — that is the gap.**
- **Triage queue UX:** `artifacts/resupply-api/src/routes/admin/inbound-faxes.ts` + `artifacts/cpap-fitter/src/pages/admin/admin-inbound-faxes.tsx` (`new → triaged → attached → archived` state machine with patient-candidate suggestion). Mirror exactly.
- **Integration package shape:** `lib/resupply-integrations-care-orchestrator/src/{config,client,stub,index}.ts` (config-or-null → stub fallback → live client → typed snapshot). Mirror.
- **DaVinci PAS reuse:** `lib/resupply-integrations-davinci-pas/src/{build-bundle,client}.ts` + `artifacts/resupply-api/src/routes/admin/davinci-pas-submit.ts`. Phase 3 calls these, no new PAS work needed.
- **NPPES lookup:** `artifacts/resupply-api/src/lib/nppes.ts`. Phase 2 provider matcher reuses it.
- **Audit:** every PHI write calls `logAudit` from `@workspace/resupply-audit`.
- **pg-boss workers:** register via `registerXxxJob(boss)` in `artifacts/resupply-api/src/worker/index.ts`.
- **Schema:** new migrations start at `0144` (highest is `0143_inventory_reconciliation_submit_fn.sql`).

### Phase 1 (weeks 1–4) — Parachute intake → typed order → triage queue

Stand up the dispatcher behind the already-mounted webhook so real Parachute orders flow into a CSR queue.

- **New package** `lib/resupply-integrations-parachute/src/` — `config.ts` (reads `PARACHUTE_*` env), `client.ts`, `stub.ts`, `parse-order.ts` (Parachute JSON → typed `ParachuteOrder`), `verify-signature.ts` (HMAC on `x-parachute-signature`), `index.ts`.
- **New dispatcher** `artifacts/resupply-api/src/lib/inbound-dispatchers/parachute.ts` + worker `artifacts/resupply-api/src/worker/jobs/inbound-webhook-dispatch.ts` drains pending `inbound_webhooks` rows via the existing `inbound_webhooks_pending_idx`.
- **Modify** `routes/integrations-inbound.ts` to verify signature inline before insert (currently a TODO).
- **Schema `0144_inbound_referral_orders.sql`:** `resupply.inbound_referral_orders` (id, source, source_order_id UNIQUE per source, inbound_webhook_id FK, patient_match_id FK nullable, provider_match_id FK nullable, payer_name, ordering_npi, hcpcs_items_json, icd10_codes_json, triage_status enum, assigned_admin_user_id, accepted_order_id FK, timestamps) + `resupply.inbound_referral_documents` (attachment metadata with `object_key`, mirrored to storage via the same path as `fax/ingest-inbound.ts`).
- **Admin UI** copy `admin-inbound-faxes.{tsx,ts}` → `admin-inbound-referrals.{tsx,ts}`; mount in `console.tsx`; gate with `requirePermission("conversations.manage")`.
- **Verify:** Vitest on `parse-order.ts` + `verify-signature.ts`; record a Parachute sandbox webhook into the existing `test` source slug and walk new → triaged → accepted; assert `accepted_order_id` is stamped and audit row written.

### Phase 2 (weeks 5–8) — Auto-match + AI triage + one-click accept

Collapse the queue by auto-resolving patient (DOB + last-name + phone fallback) and provider (NPI → `providers` table from migration 0071, NPPES fallback), and AI-classify intent (new patient / refill / replacement / resupply).

- **New helpers** under `routes/admin/` or `lib/inbound-dispatchers/`: `match-patient.ts`, `match-provider.ts`, `ai-classify.ts` (Claude Sonnet 4.6 via `lib/resupply-ai` — mirror `routes/admin/conversation-triage.ts`).
- **Schema `0145_inbound_referral_ai_and_accept.sql`:** add `ai_classification_json jsonb`, `ai_confidence numeric(3,2)`, `accepted_at`, `accepted_by_user_id` to `inbound_referral_orders`.
- **New route** `POST /admin/inbound-referrals/:id/accept` — resolves patient/provider (creates if missing), opens shop order/episode, attaches `inbound_referral_documents` rows to `prescriptions`/`patient_documents`, transitions `triage_status='accepted'`. Mirror the `attached` transition in `admin/inbound-faxes.ts` lines 314–340.
- **Verify:** seed two test orders (matched + ambiguous); assert auto-promotion behavior; assert accept produces patient + Rx + episode + audit row.

### Phase 3 (weeks 9–12) — Prior-auth pre-flight automation

Auto-answer "does this payer need PA, has eligibility been verified, are docs missing?" the moment an order lands.

- **New worker** `artifacts/resupply-api/src/worker/jobs/inbound-referral-preflight.ts` — calls `pa_payer_profiles` (migration 0128) for PA rules by HCPCS+payer; calls `routes/admin/eligibility-checks.ts` for 270/271; calls `routes/admin/davinci-pas-submit.ts` when the payer has a DaVinci endpoint; falls back to enqueueing `physician-fax-outreach` for missing F2F/chart notes.
- **Schema `0146_inbound_referral_preflight.sql`:** `resupply.inbound_referral_preflight_checks` (id, referral_id FK, check_kind enum, outcome_json, created_at).
- **Admin UI** extend `admin-inbound-referrals.tsx` with a "Pre-flight" pane + "Run pre-flight now" button (`POST /admin/inbound-referrals/:id/run-preflight`).
- **Verify:** seed three orders (DaVinci PA payer, fax-PA payer, no-PA payer); assert exactly one pre-flight row each and that fax outreach queues only for the doc-gap case.

### Phase 4 (weeks 13–16) — Generic EHR connector (SMART on FHIR)

Make Athena/Epic/PointClickCare and other EHRs land into the **same dispatcher** as Parachute, no new architecture.

- **New package** `lib/resupply-integrations-ehr-fhir/src/` — `adapter.ts`, `smart-launch.ts` (backend-services JWT/JWKS auth), `resource-mappers.ts`, `index.ts`. Extends the existing read-only FHIR surface at `routes/fhir/index.ts` to **accept** posted `ServiceRequest`/`MedicationRequest`/`DocumentReference` bundles.
- **Modify** `routes/fhir/index.ts` — add `POST /fhir/r4/ServiceRequest` gated by new `requireSmartFhirAccess` middleware (JWT validated against per-tenant JWKS). Successful posts insert into `inbound_webhooks` with `source='ehr_fhir_${tenant}'` — Phase 1+2 dispatcher reuses cleanly.
- **Modify** `routes/integrations-inbound.ts` — extend `SUPPORTED_SOURCES` to accept `ehr_fhir_*` slugs.
- **Schema `0147_ehr_fhir_tenants.sql`:** `resupply.ehr_fhir_tenants` (id, slug, display_name, jwks_uri, audience, enabled, audit cols).
- **Admin UI** `admin-ehr-tenants.tsx` (CRUD) + add "Source" column to `admin-inbound-referrals.tsx`.
- **Verify:** self-signed JWKS in tests; POST a `ServiceRequest` bundle; assert it lands in `inbound_webhooks`, dispatches, shows in queue with source populated.

### Phase 5 (weeks 17–20) — Bidirectional status callbacks

Clinicians see lifecycle updates in their portal/EHR without calling.

- **New worker** `artifacts/resupply-api/src/worker/jobs/inbound-referral-status-outbound.ts` listens for `order.status_changed`, `prior_auth.decision`, `shop_order.shipped`; POSTs to Parachute + EHR FHIR subscription endpoints. Reuses the existing `webhook-dispatcher.ts` (HMAC sign + expo backoff + `webhook_deliveries`).
- **Schema `0148_inbound_referral_status_outbox.sql`:** `resupply.inbound_referral_status_outbox` (referral_id FK, event_type, payload_json, status enum, attempts, next_attempt_at).
- **Admin UI** timeline ribbon on `admin-inbound-referrals.tsx` + manual "Resend status" button.
- **Verify:** trigger a status change; assert one outbox row per subscribed source; mock partner endpoint; assert HMAC + retry semantics.

### Phase 6 (weeks 21–24) — PWA enhancements

Close the gap on Brightree/NikoHealth's patient-app strengths without going native.

- **Service worker** `artifacts/cpap-fitter/src/service-worker.ts` (Workbox precache); offline-cache `/api/me/*` patient-portal reads + last-N order summaries.
- **Push notifications:** `shop_customer_push_subscriptions` table (from migration 0045) already exists — add `worker/jobs/order-status-push.ts` to fan out on `shop_order.status_changed`.
- **Apple Wallet** extend `artifacts/resupply-api/src/lib/apple-wallet/` to encode active inbound-referral status on the pass back.
- **Clinician share link:** new public read-only route `/portal/clinician/:referralToken` showing the outbound timeline (single-link share for partners who do not consume webhooks). Token pattern from `lib/fax-document-token.ts`.
- **Schema `0205_clinician_share_tokens.sql`:** `resupply.clinician_share_tokens` (referral_id FK, token_hash, expires_at, last_viewed_at).
- **Verify:** Lighthouse PWA ≥ 90; Cypress offline test on `/account`; manual end-to-end Web Push.

---

## Cross-phase invariants

- Zod parsing at every HTTP boundary (`integrations-inbound.ts` line 30 is the template).
- No request body in logs — IDs + dedupe keys only.
- All Supabase access through `getSupabaseServiceRoleClient().schema("resupply")`.
- Every PHI write calls `logAudit` (HMAC-chained via migration 0116).
- Admin routes that mutate orders gate on `requirePermission("conversations.manage")` or stronger — never bare `requireAdmin`.

## Critical files to read first

- `artifacts/resupply-api/src/routes/integrations-inbound.ts` (intake — Parachute slug already there)
- `artifacts/resupply-api/src/routes/admin/inbound-faxes.ts` + `artifacts/cpap-fitter/src/pages/admin/admin-inbound-faxes.tsx` (UX mirror)
- `artifacts/resupply-api/src/routes/admin/davinci-pas-submit.ts` (PA reuse)
- `lib/resupply-integrations-care-orchestrator/src/index.ts` (package shape mirror)
- `lib/resupply-db/drizzle/0138_phase_6_payments_and_inbound.sql` (existing `inbound_webhooks` schema)
- `artifacts/resupply-api/src/lib/nppes.ts` (provider matcher reuse)

## End-to-end verification

After Phase 1: post a signed test payload to `POST /integrations/inbound/parachute`, watch it land in `inbound_webhooks`, be drained by the dispatcher, and appear in the new admin referrals queue.

After Phase 3: same payload should auto-classify, auto-match patient + provider, and produce 1–3 pre-flight check rows (eligibility, PA-requirement, optional PAS submission) inline on the referral.

After Phase 5: accept the order, change its status to `shipped`, and assert an outbox row was sent back to the original source with the correct HMAC signature.

After Phase 6: patient portal works offline (cached), a push notification fires on order status change, and the clinician-share link renders the lifecycle timeline.

## Branch & PR

All work lands on `claude/dme-cpap-research-comparison-fCPWk`. Each phase = one PR (draft) with its own migration(s), tests, and admin UI changes. Open draft PRs early so review can run alongside development.
