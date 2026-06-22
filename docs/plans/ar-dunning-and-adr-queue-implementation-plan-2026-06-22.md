# Implementation Plans — Patient AR Dunning & Medicare ADR Queue (2026-06-22)

**Audience:** CareMetric Breathe engineering.
**Status:** Plan only — no code written. Review before build.
**Scope:** Two net-new, fail-soft, feature-flagged subsystems from the
`feature-gap-analysis-external-benchmark-2026-06-22.md` Tier-2 list:

1. **Patient AR dunning / collections engine** (§A) — escalating, consent-aware
   outreach on aging patient balances, reusing the existing outreach-playbook,
   statement, and comm-prefs infrastructure.
2. **Medicare ADR / audit-response queue** (§B) — track payer Additional
   Documentation Requests against a hard deadline, package the response, record
   the outcome — modeled almost 1:1 on the existing bill-hold / paperwork-
   requirements pattern.

Both follow the repo's invariants: Supabase-only data path, Zod at the HTTP
boundary, `requirePermission` gating, fail-soft feature flags seeded **OFF**,
HTTP-decoupled worker jobs with opt-in cron, no PHI in logs, no new column
encryption, no `audit_log` writes.

---

## §A — Patient AR Dunning / Collections Engine

### A.0 Problem & goal

Today patient-responsibility balances get a **statement** (one-shot, consent +
quiet-hours aware via `billing-statement-send.ts`) and optional payment plans /
autopay. There is **no escalating follow-up** when a statement goes unpaid and
no structured handoff to a collections agency. Goal: a **dunning ladder** —
statement → reminder → second notice → final notice → (optional) agency export
— that is consent/TCPA-safe, pauses the moment a balance is paid or a payment
plan is active, and surfaces an AR **collections worklist** for staff.

### A.1 Reuse map (don't rebuild these)

| Need                       | Reuse                                                | Path                                                                                     |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Multi-touch cadence engine | `outreach_playbooks` step/run/log model + dispatcher | `migrations/0263_outreach_playbooks.sql`, `worker/jobs/outreach-playbook-tick.ts`        |
| Escalation ladder pattern  | reminder escalation (delay/cap, resolution signal)   | `worker/jobs/reminder-escalation.ts`                                                     |
| Channel send + gating      | statement channel picker                             | `lib/billing/statement-send.ts` (`pickStatementChannel`)                                 |
| TCPA / DND / consent       | comm-prefs                                           | `lib/comm-prefs.ts` (`isOutsideSmsSendWindow`, `shouldSendEmail/Sms`)                    |
| Balance / overdue math     | payment-plan domain                                  | `lib/resupply-domain/src/payment-plan.ts` (`computePlanSummary`)                         |
| Worklist page pattern      | denials worklist (route + api + page + nav)          | `denials-worklist.ts` / `denials-worklist-api.ts` / `admin-billing-denials-worklist.tsx` |
| Feature flag plumbing      | flags table + reader                                 | `migrations/0149_feature_flags.sql`, `lib/feature-flags.ts`                              |

### A.2 Data model (one new migration, next free prefix)

`migrations/0NNN_patient_dunning.sql`:

- **`resupply.patient_dunning_runs`** — one active run per patient balance cycle:
  `id`, `org_id`, `patient_id`, `opened_balance_cents`, `current_step`
  (`statement|reminder|second_notice|final_notice|agency|resolved`),
  `next_action_at timestamptz`, `status` (`active|paused|resolved|cancelled`),
  `paused_reason` (`payment_plan_active|autopay_enrolled|disputed|manual_hold`),
  `resolved_reason` (`paid|written_off|agency_handoff|manual`), `created_at`,
  `updated_at`. Partial index `(status, next_action_at) WHERE status='active'`.
- **`resupply.patient_dunning_events`** — append-only touch log:
  `run_id`, `step`, `channel` (`sms|email|letter|none`), `outcome`
  (`sent|skipped|failed|paused|resolved`), `detail` (reason code),
  `amount_at_touch_cents`, `actor_email`, `occurred_at`. (Mirrors
  `outreach_playbook_step_log`; no PHI in `detail`.)
- **Dunning policy** — model the ladder timing as a small **seeded config**
  (reuse `app_config` non-catalog key `collections.dunning_policy`, JSON: array
  of `{step, day_offset, channel}`), so operators can tune cadence without a
  migration. Default ladder: `reminder` +7d (email/sms), `second_notice` +21d,
  `final_notice` +35d, `agency` +60d (no auto-send — produces an export, see
  A.6). Keep it config not hard-coded, mirroring how playbooks are data-driven.

> **Balance source of truth.** Open patient AR = `SUM(insurance_claims.
patient_responsibility_cents WHERE delivery_status IN ('pending','sent',
'failed')) − SUM(patient_payments.amount_cents WHERE status='captured')`
> (per the AR-infra findings). A run is opened when this crosses a threshold
> and no active payment plan / autopay exists.

### A.3 Worker jobs (two, both opt-in cron, both flag-gated)

`worker/jobs/dunning-open-scan.ts` — `collections.dunning-open-scan`:

- For each active org (`forEachActiveOrg`), find patients with open AR over a
  configurable floor (e.g. `$25`) and **no** active `patient_dunning_runs`, no
  active payment plan, no autopay authorization → open a run at `current_step
= statement`, `next_action_at = now` (or align to existing statement send).
- Cron via `COLLECTIONS_DUNNING_SCAN_CRON` (unset = registered, not scheduled).

`worker/jobs/dunning-tick.ts` — `collections.dunning-dispatcher`:

- Claim active runs where `next_action_at <= now()` (optimistic `WHERE` update,
  same pattern as `outreach-playbook-tick.ts`).
- **Resolution check first** (mirrors reminder-escalation): recompute balance;
  if `<= 0` → `status=resolved, resolved_reason=paid`, log, stop. If a payment
  plan or autopay became active → `status=paused, paused_reason=...`.
- Else execute `current_step`'s channel via `pickStatementChannel()` +
  `shouldSendSms/Email` + `isOutsideSmsSendWindow` (defer, don't drop, on DND);
  write a `patient_dunning_events` row; advance `current_step` / `next_action_at`
  from the policy. At `agency` step: **do not send** — flag the run for the
  export worklist and stop auto-advancing.
- Schedule at 18:00 UTC like reminder-escalation (inside US 9am–8pm for SMS).
- Register both in `worker/index.ts` via `safeRegister(...)`, wrapped in
  `registerIfProvisioned(boss, "patient_dunning_runs", [...], ...)`.

### A.4 Feature flags (seed OFF)

Add to the new migration + `FEATURE_FLAG_KEYS` in `lib/feature-flags.ts`:

- `collections.dunning` (master; OFF) — gates both jobs; OFF pauses sends
  without cancelling runs (same semantics as `outreach_playbooks.dispatcher`).
- `collections.agency_export` (OFF) — enables the agency-handoff export.

### A.5 Admin API + UI (mirror denials worklist)

- Route `routes/admin/collections-worklist.ts`, `requirePermission("reports.read")`,
  `adminReadRateLimiter`:
  - `GET /admin/billing/collections-worklist` — active runs ranked by
    `opened_balance_cents` and age, with `{patientId, patientName, balanceCents,
currentStep, nextActionAt, lastTouch}`.
  - `POST /admin/billing/collections/:runId/pause` / `/resolve` / `/cancel`
    (`requirePermission("billing.write")` or equivalent existing perm) — manual
    overrides (dispute hold, write-off, mark paid).
  - `GET /admin/billing/collections/agency-export` (flag-gated) — CSV of
    `agency`-step runs for the collections agency (formula-injection guarded,
    same helper PacWare export uses).
- SPA page `pages/admin/admin-billing-collections-worklist.tsx` + api wrapper
  `lib/admin/collections-worklist-api.ts` (mirror the denials trio).
- Nav: add a **"Collections"** tab under Billing → Worklists in `AppShell.tsx`
  `NAV_GROUPS` (`requiredPermission: "reports.read"`), plus an inbox `badgeKey`
  for count of runs needing a human (agency step / failed sends).

### A.6 Agency handoff (deliberately manual)

No auto-send at the `agency` step — it produces a reviewable **export** only.
This keeps a human in the loop before an account is sent to collections (legal/
reputational risk) and matches the "PacWare has no API → export + verify"
philosophy already in the repo.

### A.7 Tests

- Pure unit: ladder advancement, resolution-on-paid, pause-on-plan, DND defer
  (mirror `payment-plan.ts` / comm-prefs test style — pure functions, no I/O).
- Dispatcher: claim-once concurrency, flag-OFF pauses without cancel.
- Route: permission gate present (passes `check-admin-route-gates.sh`).

### A.8 Risks / call-outs

- **TCPA is the main risk** — reuse `comm-prefs.ts` verbatim; never add a new
  send path. Letters (`channel=letter`) are out-of-band (no auto-mail v1).
- Balance recompute must run **at touch time**, not just at open, so a partial
  payment between touches correctly de-escalates.
- Keep `detail`/logs PHI-free (reason codes only).

---

## §B — Medicare ADR / Audit-Response Queue

### B.0 Problem & goal

A payer (or its contractor — RAC/CERT/TPE/UPIC) issues an **Additional
Documentation Request**: "send records supporting claim X by <date>." Miss the
deadline → automatic denial / recoupment. Today there's **no structured place**
to log an ADR, assemble the response packet, track the deadline, or record the
outcome. Goal: an **ADR queue** — intake (often from an inbound fax) → assemble
required docs → mark sent (fax/mail/portal) → record outcome — with deadline
SLA surfacing.

### B.1 Reuse map (this is mostly a re-skin of bill-hold)

| Need                                 | Reuse                                      | Path                                                                                   |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Requirement ledger + satisfy-via-fax | `claim_paperwork_requirements` + auto-file | `migrations/0253_...`, `lib/fax/auto-file-signed.ts`                                   |
| Deadline / SLA worklist + sweep      | prior-auth expiry + MCO SLA status enum    | `worker/jobs/prior-auth-expiry-sweep.ts`, `migrations/0133_...`                        |
| Claim linkage + event trail          | claims + `insurance_claim_events`          | `migrations/0118_insurance_claims.sql`                                                 |
| Inbound ADR arrival (fax)            | inbound fax triage + OCR                   | `routes/admin/inbound-faxes.ts`, `lib/inbound-fax/ocr.ts`, `lib/fax/ingest-inbound.ts` |
| Document storage / attach            | patient_documents + object storage         | `migrations/0049_patient_documents.sql`                                                |
| Outbound packet (fax) + outcome      | appeal letter delivery + outcome enum      | `routes/admin/claim-appeals.ts`, `migrations/0428_...`                                 |
| Worklist page + nav + flags          | bill-hold worklist trio                    | `routes/admin/claim-paperwork.ts`, `admin-billing-bill-hold.tsx`                       |

### B.2 Data model (one new migration)

`migrations/0NNN_claim_adr.sql`:

- **`resupply.claim_adr_requests`** — the ADR header:
  `id`, `org_id`, `claim_id` (FK `insurance_claims` ON DELETE CASCADE),
  `patient_id`, `source` (`rac|cert|tpe|upic|payer_medical_review|other`),
  `payer_name`, `received_at date`, `response_due date` (the hard deadline),
  `status` (`open|in_progress|submitted|closed`),
  `outcome` (`pending|favorable|partial|unfavorable|withdrawn`),
  `received_via` (`inbound_fax|mail|portal|email|manual`),
  `received_inbound_fax_id` (soft FK `inbound_faxes.id`),
  `submitted_at`, `submitted_via` (`fax|mail|portal`), `submitted_packet_object_key`,
  `sla_status` (`on_track|at_risk|overdue|decided`) — denormalized like the PA
  MCO SLA pattern, recomputed by the sweep. `notes`, `created_at`, `updated_at`.
  Partial index `(sla_status, response_due) WHERE status IN ('open','in_progress')`.
- **`resupply.claim_adr_documents`** — the response packet line items
  (what's required / attached), mirroring `claim_paperwork_requirements`:
  `adr_id`, `requirement_type` (`prescription|swo|cmn|dwo|sleep_study|
proof_of_delivery|medical_records|face_to_face|other`), `label`,
  `status` (`outstanding|attached|waived`), `document_id` (soft FK
  `patient_documents.id`), `attached_at`, `attached_via`.

> Why a separate table vs. extending bill-hold: bill-hold blocks **outbound
> billing pre-submission**; an ADR is a **post-adjudication** response with its
> own deadline + payer-audit semantics + outcome. Same _shape_, different
> lifecycle — keep them distinct to avoid overloading `bill_hold`.

### B.3 Worker job (one sweep, deadline SLA)

`worker/jobs/adr-sla-sweep.ts` — `billing.adr-sla-sweep` (mirror
`prior-auth-expiry-sweep.ts`):

- Per active org: recompute `sla_status` from `response_due` vs `today`
  (`overdue` if past + still open; `at_risk` within N days — default 5;
  `decided` once `status='submitted'/'closed'`).
- Emit a `csr_compliance_alerts` row (reuse existing table/enum — add
  `adr_due`/`adr_overdue` alert types in the migration) for pre-deadline
  heads-up at 14/7/2 days, so it shows in the existing alert surface.
- Cron `ADR_SLA_SWEEP_CRON` (opt-in) or hardcoded daily like the PA sweep.
- Register in `worker/index.ts` via `registerIfProvisioned(..., "claim_adr_requests", ...)`.

### B.4 Auto-link inbound ADR faxes (optional, phase 2)

Extend `lib/fax/auto-file-signed.ts` matching so an inbound fax whose OCR text
matches an open ADR's claim/payer can be linked to `received_inbound_fax_id`,
and so returned-document faxes can satisfy `claim_adr_documents` rows — exactly
the existing `expected_return_fax_e164` → `satisfied_inbound_fax_id` mechanic.
Phase 1 can be manual attach from the inbound-fax triage screen.

### B.5 Feature flag (seed OFF)

`billing.adr_queue` (OFF) — gates the sweep + alert emission + nav visibility.
Add to migration seed + `FEATURE_FLAG_KEYS`.

### B.6 Admin API + UI (mirror bill-hold worklist)

- Route `routes/admin/claim-adr.ts`, `requirePermission("reports.read")` for
  reads / a billing-write perm for mutations:
  - `GET /admin/billing/adr-worklist` — open ADRs ordered by `response_due`
    asc, with `sla_status`, claim/patient/payer, outstanding doc count.
  - `GET /admin/billing/adr/:id` — detail + document checklist.
  - `POST /admin/billing/adr` — create (from a claim or an inbound fax).
  - `PATCH /admin/billing/adr/:id` — status / outcome / attach docs / mark
    submitted (records `insurance_claim_events` note via existing helper).
  - `GET /admin/billing/adr/:id/packet` — assemble + stream the response packet
    PDF (reuse the appeal-PDF/object-storage assembly path).
- SPA `pages/admin/admin-billing-adr-worklist.tsx` + `lib/admin/adr-api.ts`
  (mirror bill-hold trio). KPI cards: "Open ADRs", "Due ≤7 days", "Overdue".
  Table: claim/patient, payer, source, received, **due (with at-risk/overdue
  badge)**, outstanding docs. Detail drawer = document checklist + "mark sent".
- Nav: **"ADR / Audit response"** tab under Billing → Worklists in
  `AppShell.tsx`, `requiredPermission: "reports.read"`, badge = overdue+at-risk
  count via `fetchAdminInboxCounts()`.

### B.7 Compliance posture note

This is **operational** (deadline tracking + document packaging), **not** a
compliance-attestation engine — consistent with CLAUDE.md's "compliance handled
out of band" rule (migration 0156 retired attestation machinery). It writes to
its own tables + `insurance_claim_events`; it does **not** write `audit_log`.

### B.8 Tests

- Pure: `sla_status` derivation from `response_due`/today (at-risk window,
  overdue, decided). Packet completeness (all required docs attached).
- Sweep: alert emission at thresholds; idempotent re-run.
- Route: permission gates present; ADR cannot be marked `submitted` with
  outstanding required docs (unless explicitly overridden).

---

## Sequencing & sizing

| Phase | Deliverable                                                | Rough size |
| ----- | ---------------------------------------------------------- | ---------- |
| A1    | Dunning migration + balance/ladder pure logic + tests      | S–M        |
| A2    | Two worker jobs (open-scan, tick) + flags                  | M          |
| A3    | Collections worklist route + page + nav + manual overrides | M          |
| A4    | Agency export (flag-gated, guarded CSV)                    | S          |
| B1    | ADR migration (+ alert types) + SLA pure logic + tests     | S–M        |
| B2    | ADR sweep + flag + alerts                                  | S–M        |
| B3    | ADR worklist route + page + nav + packet assembly          | M          |
| B4    | Inbound-fax auto-link (phase 2)                            | S          |

**Recommended order:** B1→B3 first (ADR is a tighter, lower-risk re-skin of an
existing pattern and addresses the highest-dollar audit risk), then A1→A4
(dunning carries TCPA risk and benefits from a careful review of the send
path). Each phase is independently shippable behind its OFF flag.

## Cross-cutting checklist (applies to every PR)

- Migration prefix passes `check-resupply-migration-prefix.sh`; **do not** edit
  `meta/_journal.json`.
- New flag key added to BOTH the migration seed and `FEATURE_FLAG_KEYS` (boot
  fails on mismatch).
- Every admin mutation has `requirePermission` (passes `check-admin-route-gates.sh`).
- Supabase service-role / org-scoped client only — no raw `pg` outside
  `lib/resupply-db` (Rule 7).
- Worker jobs registered HTTP-decoupled, cron opt-in, fail-soft; never
  `process.exit` on job failure.
- No PHI / order bodies / patient identifiers in logs — reason codes only.
- Flags seeded **OFF**; a missing cron leaves the job registered-but-idle.
