# Complete Domain Review — 2026-06-20

A full, domain-by-domain review of CareMetric Breathe (codename PennFit) to
identify gaps and confirm the system works logically end to end. Engineering
health was established by running the real toolchain; functional gaps were
found by reading the actual code path-by-path (every finding below cites
`file:line` and was verified, not inferred).

## 1. Engineering health — all green

Run with `npm_config_engine_strict=false` (this container is Node 22 / the
repo pins Node 24; the override only relaxes the version gate, the code runs
unchanged):

| Check                                                                           | Result                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `tsc` typecheck (all workspaces)                                                | **Pass** — 0 errors                                |
| ESLint (`--max-warnings 0`)                                                     | **Pass** — 0 warnings                              |
| Architecture / migration-prefix / admin-route-gate / tenant-isolation CI checks | **Pass**                                           |
| Vitest — `resupply-api`                                                         | **6,263 passed**, 10 skipped, 0 failed (622 files) |
| Vitest — all `lib/*` packages                                                   | **Pass** (one env-polluted test — see below)       |
| API esbuild bundle                                                              | **Builds** (13 MB `dist/index.mjs`)                |
| Storefront/admin SPA Vite build                                                 | **Builds**                                         |
| TODO/FIXME/HACK markers in non-test code                                        | **0**                                              |
| Orphaned/unmounted routes (213 admin routers)                                   | **0** — all imported and mounted                   |
| Boot-contract invariants (healthz liveness / worker decouple / SIGTERM)         | **Intact**                                         |

**One red test, not a code defect — ✅ fixed in this PR:**
`lib/resupply-telecom/src/lookup.test.ts` → "throws when credentials are
missing" failed _only in this container_ because the remote environment injects
real `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, so the factory did not throw.
The production code is correctly fail-closed; the **test** lacked env isolation
(it relied on `process.env` being unset). Now made hermetic with
`vi.stubEnv("TWILIO_ACCOUNT_SID", "")` + `vi.unstubAllEnvs()`. Original note
(for reference): wrap with `vi.stubEnv`/`delete process.env.TWILIO_*` in a
`beforeEach`.

## 2. Cross-cutting theme — incomplete multi-tenant `orgId` threading

The single most important finding, independently surfaced by four separate
domain reviews. The platform is mid-migration from single-tenant (the Penn
Home Medical Supply "seed" org) to multi-tenant. The **authenticated admin
surface is correct** — patient/billing/conversation routes thread `req.orgId`
and fail closed when it is missing. But a set of **detached, webhook-adjacent,
and async callsites** resolve `resolveSeedOrgId()` as their _only_ org source
even when the real tenant is in scope. For the live single tenant (which _is_
the seed org) everything works; for any second tenant these paths silently
operate against the wrong org.

`resolveSeedOrgId()` itself is used legitimately in ~140 files (webhook
handlers with no `req.orgId`, workers that iterate all orgs, correct
fallbacks). The bug is the narrow subset where a known tenant is available but
not threaded:

| Sev      | Path                                                    | File:line                                                                                   | Effect for a non-seed tenant                                                                                                                         |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Inbound SMS confirm / STOP / START                      | `routes/sms/inbound.ts:906,1116,1144` → `lib/messaging/order-flow.ts:188,1032,1095`         | Patient texts "YES" → no order placed, gets generic "we'll follow up"; STOP fails to opt out (TCPA exposure)                                         |
| High     | FHIR `Patient` / `$everything`                          | `routes/fhir/index.ts:122,183`                                                              | Non-seed admin gets 404 for their own patients                                                                                                       |
| High     | Voice post-call handoff + summary + Deepgram transcript | `lib/voice/post-call-handoff.ts:109`, `lib/voice/ws-handler.ts:1816,1635`                   | Distressed-patient CSR handoff silently dropped; PHI transcript tagged to wrong org                                                                  |
| Med      | Inbound voice caller identification                     | `routes/voice/inbound-reorder.ts:554` → `resolve-caller.ts:52`                              | Caller matched by phone with no org filter → cross-tenant patient/episode bind                                                                       |
| Med/High | Eligibility **quick-check**                             | `routes/admin/eligibility-quick-check.ts:83` → `lib/billing/eligibility-quick-check.ts:120` | Uses seed tenant's billing identity/clearinghouse; non-seed tenant's `payerProfileId` 404s. Sibling patient-attached route threads `orgId` correctly |
| Med      | Provider e-sign portal                                  | `routes/provider/portal.ts:73,150,227,411,498` + `requireProvider.ts:111`                   | Provider queue filtered by seed `org_id`; a non-seed tenant's signature requests never appear and provider can only sign seed-org docs               |
| Low      | Object-storage helpers                                  | `lib/object-storage/objectStorage.ts:80,115`                                                | Not tenant-partitioned — but upstream callers derive the key from an already-org-scoped DB row, so no reachable cross-tenant read                    |
| Low      | davinci-pas Bearer token namespace                      | `routes/admin/davinci-pas-submit.ts:13,254`                                                 | Per-payer PAS creds shared across tenants via process env                                                                                            |

**Recommended remediation:** thread `orgId` (already in scope at each caller)
into `placeResupplyOrderForConversation` / `pausePatient` / `reactivatePatient`
(they already accept an optional `orgId`), the three voice post-call helpers,
and the two FHIR reads; add an `org_id` filter to `resolveCallerByPhone`. This
is a contained, well-defined fix — the callers already have the tenant.

**Status (this PR):** the High rows above plus the eligibility quick-check
row are **fixed** — `orgId` is now threaded through the SMS confirm/STOP/START
path, the FHIR `Patient`/`$everything` reads (now scoped to the calling
admin's `req.orgId`), the three voice post-call helpers (CSR handoff, summary
message, Deepgram transcript — falling back to seed only when the session
carries no org), and the eligibility quick-check (fail-closed on `req.orgId`,
matching the sibling verify route). The **Med inbound-voice caller-ID** is now
**fixed** too — `resolveCallerByPhone` takes the dialed line's `orgId` and
filters both the `patients` and `shop_customers` lookups by `org_id`, so a
caller can no longer be bound to another tenant's account. Only the Low
davinci-PAS token-namespace row remains open. Full `resupply-api` suite stays
green.

## 3. Billing / revenue-cycle domain

The EDI parsers (837P/835/277CA/999/271), payment plans, secondary COB, and
submit/transfer concurrency are genuinely strong. Gaps cluster around
**status-derivation and the manual-vs-automated path split**.

### High

1. **Eligibility re-verify surface is dead.** ✅ **Fixed in this PR.** The
   success path inserted an `eligibility_checks` row but never stamped
   `insurance_coverages.verified_at` (`lib/billing/eligibility-verifier.ts`).
   The worklist and batch rank by `verified_at`, so a just-verified coverage
   stayed "never verified" forever, re-surfacing the same patients and
   re-firing 270s endlessly. Now stamped (best-effort) on a successful 271
   parse in **both** resolution paths — the real-time verifier and the async
   SFTP 271 reconciliation in `office-ally-inbound-poll.ts`.
2. **Manual ERA ingest skips AI denial analysis.** ✅ **Fixed in this PR.**
   `era-ingest.ts` called `reconcileEra` but, unlike the poller's
   `dispatch835`, never inserted `claim_denial_analyses`, so a denial from a
   CSR-uploaded 835 sat on the worklist permanently unanalyzed. The poller's
   `runDenialAnalysisQuietly` was extracted to a shared
   `lib/billing/denial-analysis-runner.ts` (`runDenialAnalysis`); the poller
   calls it fire-and-forget (unchanged), and the manual route now runs it
   (per the owner's decision: **awaited** before responding, returning a
   `denialAnalysesRun` count) for each matched denied outcome. Both ERA entry
   points share one implementation so they can't diverge again. New
   parity test added.
3. **Partial automated 835s are never re-reconciled.** ✅ **Fixed in this
   PR.** The HTTP `era-ingest` route exempts `partial` files from SHA dedupe
   so they can be re-reconciled, but `dispatch835` `return 0`'d for **any**
   existing `era_files` row including `partial`, stranding payments when a
   claim was created locally after the 835 first landed. Verified
   `reconcileEra` is per-claim idempotent (the `insurance_claim_events`
   `payer_ref` marker skips already-applied claims), so re-running only
   applies newly-matchable blocks — no double-post. `dispatch835` now mirrors
   the HTTP route: a `partial` row is **reused and re-reconciled** on
   re-delivery (the 835 body isn't persisted, so re-delivery is the only
   recovery path); a `processed` row still short-circuits. New
   re-reconcile test added.
4. **Same-or-Similar cache is write-only.** ✅ **Fixed in this PR.**
   `medicare_same_or_similar_checks` was read nowhere outside its own route,
   even though the header claimed it feeds the preflight engine. `claim-
preflight.ts` now reads the latest cached check per HCPCS for a
   Medicare-like payer and emits (per the owner's decision) **non-blocking
   warnings**: `active` (rental-cycle conflict), `unknown`, and a missing or
   stale (>180-day) check all warn; `clear`/`inactive` and fresh shows an
   "ok" row. Reuses the existing payer-profile read (no extra query). New
   tests cover active / missing / stale / clear / non-Medicare.
5. **Capped-rental modifier rotation has no months 14–36 branch.** ✅
   **Fixed in this PR.** `pickModifiers` only handled `<=3` (KH) and `<=13`
   (KI/KX); a 36-month oxygen cycle emitted 23 claims with no rental-month
   modifier → denials. Reworked to the CMS capped-rental sequence (confirmed
   with the owner): **KH** month 1, **KI** months 2–3, **KJ** months 4 →
   `max_months` (so 4–13 / 4–15 / 4–36 are all covered), with **KX** still
   added on the KJ months for a compliant CPAP/BiPAP patient. This also
   corrects the previously non-standard 1–3=KH / 4–13=KI ranges. Covered by
   a new `pickModifiers` unit test.
6. **277CA rejection never updates `insurance_claims.status`.** ✅ **Fixed in
   this PR.** The 277CA handler wrote an event row but no claim status, so a
   clearinghouse-rejected claim sat at `submitted` (looked in-flight) and
   resubmission logic never fired. Per the owner's decision, added a distinct
   **`rejected`** claim status (migration `0419`, types, and the canonical
   state machine: `submitted → rejected`, `rejected → {submitted, closed}`).
   The 277CA handler now sets status — **accepted** ack → `submitted → accepted`
   (the documented 277CA intermediate) and **rejected** ack → `rejected` —
   guarded so an ERA round-trip that already resolved the claim
   (paid/denied/closed) is never downgraded; **pended** leaves it unchanged.
   Rejected claims surface for fix-and-resubmit in the **timely-filing**
   worklist (the filing clock is still running). Covered by new
   `dispatch277ca` + state-machine tests.
7. **Collections forecast / AR aging compute from disagreeing status
   literals** (no `partially_paid` state; `paid` set on any `paidCents>0`),
   systematically understating expected cash and aging denied/appealed claims
   as collectible on gross billed (`collections-forecast.ts:23`,
   `billing-reports.ts:53`).

### Medium (selected)

- ✅ **Fixed in this PR.** Appeal generation never transitioned claim →
  `appealed` nor denial-analysis → `accepted_appealed`, so appealed claims kept
  reappearing on the denials worklist as actionable. Per the owner's decision
  (transition **only when the appeal is actually sent**), the appeal-fax route
  now — on a successful Telnyx hand-off — moves a `denied` claim →
  `appealed` (guarded to the valid edge) and marks the linked (or latest)
  denial analysis `accepted_appealed`, dropping it from the worklist. New
  tests cover the denied→appealed transition and the no-op on a non-denied
  claim. _Follow-up:_ the **mail/manual** delivery channel has no system "sent"
  event, so those appeals still need a small "mark mailed" action to transition
  (intentionally out of scope under the "only when sent" choice).
- ✅ **Fixed in this PR.** `denial_codes` CARC/RARC catalog was never joined —
  the reconciler emitted bare `"CARC 16"` strings. Per the owner's decision
  (string **+** structured worklist fields): `composeDenialReason` now joins
  the global catalog and renders `"CARC 16 — Claim/service lacks information;
…"` (unknown codes fall back to bare; catalog read is fail-soft), and the
  denials worklist now surfaces structured `denialCategories` + `isTerminal`
  per item (parsed from the codes and joined to the catalog) so a biller can
  triage terminal denials from workable ones. New reconciler-side enrichment
  and worklist-API tests. _Follow-up:_ render the new fields in the SPA
  denials-worklist UI (the API now provides them).
- Da Vinci PAS Claim is always built with `diagnosis: []` and hardcoded
  `quantity: 1` (`davinci-pas-submit.ts:246`) → payer rejection.
- Denial-rate denominators disagree across three dashboards
  (`billing-benchmarks.ts`, `billing-reports.ts`, `billing-director.ts`).
- 277CA `pended` is rolled up as `accepted_277ca`
  (`office-ally-inbound-poll.ts:603`).
- ✅ **Fixed in this PR.** Fee-schedule lookup couldn't match the comma-joined
  multi-modifier rows the CSV importer accepts (`"KX,KH"`) — it exact-matched a
  single modifier, so those rates were unreachable and the line fell through to
  the wildcard. Per the owner's decision (subset + most-specific, both
  callers): a new shared `pickFeeScheduleRowByModifiers` selects the
  most-specific row whose modifier **set** is a subset of the line's modifiers
  (ties → newest `effective_from`), then wildcard, then first. Wired into both
  the claim builder's automatic pricing and the manual
  `GET /payer-fee-schedules/lookup` (now accepts a comma-separated set). New
  unit tests for the matcher.
- ✅ **Fixed in this PR.** Good-Faith-Estimate `delivered_at` was read but no
  endpoint ever wrote it, so the No Surprises Act SLA tracking was dead. Per
  the owner's decision (both actions, re-delivery allowed), two endpoints were
  added: `POST .../:id/email` re-renders the stored GFE PDF (faithful to the
  persisted items + disclaimer version) and emails it to the recipient via the
  tenant SendGrid sender, then stamps `delivered_at` + `delivery_method='email'`
  — but only on an _actual_ successful send (an unconfigured tenant is 503, a
  send failure 502, neither marks delivered); and `POST .../:id/deliver` marks
  a GFE delivered out-of-band (mail / in-person / manual email — validated
  against the DB CHECK enum) without sending. Both allow re-delivery (latest
  wins). The DME-issuer block is now shared between create and re-send so the
  PDF header can't drift. 11 new tests.
- Statements mail from a generation-time snapshot with no staleness re-check
  (`billing-statement-send.ts:318`).
- Manual-claim drafts can't be batch-submitted (no payer/lines) and have no
  duplicate guard (`manual-claim.ts:154`).

### Low

Expired PAs renewable but in no queue bucket; `eligibility-recent`/`-checks`
advertise statuses never written and swallow query errors;
`clearinghouse-credentials` inbound filter drops `277`/`271`; capped-rental
PATCH date-format mismatch; `payer_profitability` denial count misses
`appealed`; SFTP timeout classified inconsistently inbound vs outbound;
`parse-271` documents EB03 PA detection that isn't implemented.

## 4. Resupply engine / orders domain

Reminder idempotency, keyset pagination, signed-link GET/POST split, and draft
staging are carefully built. Gaps:

- **High** — Inbound SMS confirm/stop/start seed-org bug (see §2).
- **High** — `reminders.scan` fetches episodes with **no status filter**
  (`worker/jobs/reminders.ts:543`); a resolved episode older than the 48h
  conversation quiet-window can re-enter candidacy and be re-pinged.
- **Med** — Refill attestation proof is lost on the SMS path precisely because
  of the seed-org no-op (`inbound.ts:887`).
- **Med** — Escalation `csr_exhausted` alert insert isn't defensively
  idempotent (read-then-insert, no `onConflict`)
  (`reminder-escalation.ts:712`).
- ~~**Med** — `dispense-readiness` persists hardcoded `ai_model:
"gpt-4o-mini"`~~ **Withdrawn — false positive.** On verification,
  `dispense-readiness-reviewer.ts:synthesizeWithAi` is hardwired to OpenAI
  (`OPENAI_API_URL`, `DEFAULT_MODEL = "gpt-4o-mini"`); it does **not** use the
  Claude-first `selectLlmProvider` path (dispense-readiness isn't in the
  Claude-first surface table), so the persisted `gpt-4o-mini` correctly
  reflects the only model that runs. No change needed.
- **Med** — Escalation voice-disposition read can over-count "unanswered" on a
  webhook-timing race, triggering an extra automated call
  (`reminder-escalation.ts:531`).
- **Low** — best-effort dedup-key release can drop a reminder for the 22h TTL;
  draft-approve back-link failure leaves a draft `ordered` with null FK; a
  configured `voice` first-touch channel is silently downgraded to SMS/email;
  `dispense-readiness/queue` ignores an invalid `verdict` param instead of 400.

## 5. Commerce / storefront domain

Reviewed as "unusually complete and defensively coded" — Stripe webhook
idempotency, signature verification, per-tenant Connect binding, checkout cart
re-validation, returns auto-approval, and loss-claim IDOR fixes are all solid.
Gaps:

- **High** — Membership tier is half-wired: settable only by CSR PATCH writing
  a hand-typed `stripeSubscriptionId`; Stripe subscription webhooks never touch
  `membership_tier`, so a canceled/lapsed subscription keeps the tier forever;
  no storefront join flow exists (`shop-membership.ts:5,59`).
- **Med** — Post-purchase review-request emails have a correct dispatcher and
  an admin button but **no pg-boss cron** — dormant unless clicked manually
  (`shop-review-requests.ts:54`).
- **Med** — Abandoned-cart cron is opt-in/OFF by default
  (`RESUPPLY_CART_ABANDONMENT_CRON_ENABLED`); two of three lifecycle programs
  ship dormant.
- **Med** — Abandoned-cart emails render client-supplied prices/names from the
  cart snapshot, never re-validated against Stripe (`cart-snapshot.ts:51` →
  `send-cart-abandonment-email.ts:151`). No charge results, but tampered copy
  reaches the patient's inbox.
- **Med** — Stripe `charge.dispute.*` only emits a WARN log — no disputes
  table, no order flag; a missed alert = a silently lost dispute deadline
  (`webhook-handler.ts:630`).
- **Low** — back-in-stock rate limiter is per-process in-memory (N× under
  multi-replica); review-request links use platform domain not
  `resolveTenantBaseUrl`; SPA loss-claim leaks raw server strings; `/returns`
  page instructs an action hidden after 60 days with no inline explanation.

## 6. Communications / AI domain

Webhook signatures verified and fail-closed everywhere; LLM calls never throw
out of handlers; confidence gates conservative; PHI kept out of logs. Gaps:

- **High** — Three post-call voice writes hardcode seed org (see §2).
- **Med** — Inbound voice caller identification is global across tenants
  (see §2).
- **Med** — SMS office-closure / unknown-phone auto-replies fire **before** the
  MessageSid replay check (`inbound.ts:333,412`) → a replayed inbound re-fires
  the auto-reply (duplicate messaging/cost, no double-ship).
- **Med** — Inbound email from a known patient with **no episode** is silently
  dropped — no conversation created, no one notified
  (`inbound-parse.ts:311`); the SMS sibling at least replies.
- **Med** — Refill-window guard **fails open** on internal error
  (`order-flow.ts:417`) — an order can confirm/ship earlier than the rule.
- **Med** — Admin-assistant `suggest_feature` "confirm before sending" is
  prompt-only, no server-side gate (`adminAssistantTools.ts:248`).
- **Low** — Fax webhook catch blocks log raw `err` (can carry Telnyx
  body / fax numbers) instead of `serializeErr`; post-call summary has no
  OpenAI fallback (OpenAI-only deploy gets no summaries); a couple of voice log
  lines forward upstream error strings verbatim.

## 7. Integrations domain

Office Ally inbound poll, davinci-pas SSRF posture, PacWare CSV round-trip,
and registry call-time credential reads are well built. Gaps:

- **High** — Inbound webhook `vendor_pushed` nudge is a **no-op**: it writes
  `last_sync_status: "vendor_pushed"` but the nightly sweep orders by
  `last_synced_at` and never reads that status; the link is not refreshed
  sooner (`integrations-webhooks.ts:199`, `nightly-sync.ts:188`).
- **High** — FHIR reads hardcode seed org (see §2).
- **Med** — davinci-pas payer lookup uses `ilike` on a free-text payer name →
  LIKE-wildcard / arbitrary-first-row wrong-payer match
  (`davinci-pas-submit.ts:113`).
- **Med** — Nightly-sync error branch upserts `supplies: []`, clobbering the
  operator refresh-supplies route's data on every transient outage
  (`nightly-sync.ts:224` vs `integrations-refresh-supplies.ts:110`).
- **Med** — Stale "stub" availability contract: the type defines `"stub"` and
  comments reference it, but no therapy adapter ever returns it.
- **Low** — single-slot OAuth token cache thrashes under multi-tenant sync
  (token mint per patient once >1 tenant configured for a vendor); davinci PAS
  token still env-only; `vendor_pushed` write lacks event-replay dedupe.

## 8. Auth / tenant / clinical domain

Tenant isolation here is **real and structural**: the cutover to
`getOrgScopedClient` has happened (341 route files use it; the 10 leftovers are
not tenant-data reads). The CLAUDE.md note that "no application route imports
this yet" is **stale**. The auth gates, e-sign state machine, invite/token
flows, and MFA are all solid (verified). Gaps:

- **Med/High** — `eligibility-quick-check` ignores `req.orgId` and hardcodes
  the seed org (`routes/admin/eligibility-quick-check.ts:83` →
  `lib/billing/eligibility-quick-check.ts:120`); the sibling patient-attached
  route threads `orgId` correctly, so this is an isolated inconsistency that is
  both a tenant-isolation leak and a functional 404 for non-seed tenants.
- **Med** — Provider e-sign portal is hardwired to seed org across every
  handler (`routes/provider/portal.ts:73,150,227,411,498`,
  `requireProvider.ts:111`); a non-seed tenant's signature requests never reach
  the provider's queue. Latent until a second tenant uses the portal.
- **Low/Med** — `prescription_requests` has a dead `expired` terminal state:
  the enum/guards treat it as terminal, but no route/worker/lib ever sets it
  (`prescription-requests.ts:857`), so a sent packet past `expires_at` lingers
  "in flight" forever.
- **Low** — Object-storage helpers resolve seed org rather than a caller org
  (`objectStorage.ts:80,115`), but the access decision is made upstream from an
  already-org-scoped DB row, so there is no reachable cross-tenant read in the
  reviewed routes. Track for true multi-tenant storage isolation.
- **Low** — Team-management mutations gate on coarse `requireAdminOnly` rather
  than explicit `requirePermission("admin_team.manage")` (`team.ts:279,722`).
  **This is NOT a privilege-escalation hole** — `coarseAuthRoleFor()` collapses
  only the granular `admin` (super-admin) into coarse `admin`;
  supervisor/compliance_officer bucket to `agent` and are rejected. The
  super-admin-only intent holds today; switching to the explicit permission
  would make it robust against future role-mapping changes. (An earlier
  sub-review flagged this as High escalation — that was **incorrect**.)
- **Low** — `team.ts:533-576` last-admin/revoke check is a read-then-count
  TOCTOU with no row lock; narrow race, low impact.

**Verified solid:** `requireAdmin`/`requirePlatformAdmin`/`requireProvider`
all fail closed on lookup errors, re-verify platform-admin membership per
impersonation, enforce CSRF centrally, and fail closed on the granular-role
lookup; `check-admin-route-gates.sh` and `check-tenant-isolation.sh` both pass
(no ungated mutation, no direct service-role client in app code); patient CRUD
is org-scoped + `requirePermission`-gated + Zod-validated, and merge is an
org-scoped RPC that errors on cross-tenant pairs; packet/document PDF flows are
stateless (no stuck "generating" states); invite/provider/MFA tokens are
random, SHA-256-hashed, single-use, TTL-bound, with the role bound server-side;
MFA verifies TOTP before completing enrollment and hashes single-use recovery
codes with replay protection.

## 9. Prioritized remediation

1. **Thread `orgId` through the seed-org callsites in §2** (one contained
   change set; unblocks correct multi-tenant SMS confirm/opt-out, voice
   handoff, and FHIR). Highest leverage.
2. **Billing status-derivation fixes** — eligibility `verified_at` stamp (#1),
   manual-ERA denial analysis (#2/#3), capped-rental month-14+ modifiers (#5),
   277CA → claim status (#6). These are revenue-affecting.
3. **Wire the dormant lifecycle crons** (review-requests, abandoned-cart) and
   the membership↔Stripe-webhook reconciliation.
4. **Hardening**: SMS replay-before-auto-reply ordering, refill-window
   fail-closed, dispute persistence, fax-log `serializeErr`, the env-isolation
   test fix.

Nothing here blocks the current single-tenant production deployment; the High
items become correctness blockers the moment a second tenant is onboarded, and
the billing items are leaking revenue/accuracy today.
