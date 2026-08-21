# Launch triage — 2026-06-24

Triage of the pre-launch backlog for the single-tenant Penn (CareMetric
Breathe seed tenant) go-live. Scope decided with the operator: AI **voice**
and live **Office Ally e-claims** are in launch scope (live at go-live);
refund restock stays **CSR-return-only**. The multi-tenant worker fan-out and
`resolve_compliance_*` / `acquisition_funnel` org-scoping items are **deferred**
(non-PHI config/analytics bleed, not launch-blocking for single-tenant Penn).

Next available migration number: **`0474`** (`0473` is the current tip).

## Blocking vs. deferred

| #   | Item                                                 | Real bug?         | In-repo fixable            | External gate                     | Verdict                             |
| --- | ---------------------------------------------------- | ----------------- | -------------------------- | --------------------------------- | ----------------------------------- |
| 1   | Stripe double-subscription idempotency               | yes (race)        | yes, code-only             | Stripe test-mode replay           | **Launch-blocking**                 |
| 2   | `cart_hash` 500                                      | yes (repeat cart) | yes, code-only             | none                              | **Launch-blocking**                 |
| 3   | Capped-rental modifiers / OA 837P / G47.33 preflight | partial           | seed migration + preflight | OA sandbox (DMEPOS sign-off done) | **Launch-blocking** (e-claims live) |
| 4   | Voice inbound CallSid binding                        | yes (medium)      | yes, code-only             | Twilio test call                  | **Launch-blocking** (voice live)    |
| 5   | markPaid refunded→paid                               | yes (narrow)      | yes, code-only             | none                              | **Fixed: guard + test**             |
| 6   | Refund restock on `charge.refunded`                  | product decision  | n/a                        | none                              | **Decided: keep CSR-return-only**   |
| 7   | Fail-open reservation / counter & sub holds          | no (by design)    | n/a                        | n/a                               | No action                           |

## Findings (evidence)

### 1. Stripe platform double-subscription — real race

- `syncTenantStripeSubscription()` calls `stripe.subscriptions.create()` with
  **no idempotency key** and **no pre-create check** for an existing active
  subscription on the customer
  (`artifacts/resupply-api/src/lib/platform-billing/stripe.ts:847`).
- Checkout _sessions_ are idempotency-keyed; the direct subscription-create
  path is not. Webhook dedup (`stripe_webhook_events`) only catches Stripe
  **redeliveries**, not app-level double-submit/retry races.
- DB backstops exist: `tenant_billing_one_current_plan_uq` (one active sub per
  org) and a unique index on `stripe_subscription_id` (migration 0363) — so the
  DB row is protected, but an orphaned second Stripe sub can still bill.
- **Fix:** deterministic idempotency key
  `SHA256(platform-subscription|org_id|customer_id|items_hash)` on `.create()`
  - pre-create lookup that reuses an existing active sub. Code-only, no
    migration. Validation requires Stripe test-mode event-sequence replay.

### 2. `cart_hash` 500 — real bug (repeat-cart checkout)

- The `shop_orders` mirror upsert in
  `artifacts/resupply-api/src/routes/shop/checkout.ts` uses
  `onConflict: stripe_session_id`, which only swallows a session-id collision.
  A returning customer re-checking-out an **identical cart** gets a NEW Stripe
  session but the SAME `cart_hash`, so the insert trips the separate partial
  unique index `shop_orders_cart_hash_unique_idx` (migration 0062) with Postgres
  **23505** → a 500, even though the new session is valid and payable.
- **Fix:** detect the cart_hash-specific 23505 (narrowly — other 23505s still 500) and re-insert the mirror **without** `cart_hash` (NULL is exempt from the
  partial index). That keeps a local `shop_orders` row keyed by the new
  `stripe_session_id`, so the checkout-success page (which looks the order up by
  session id) doesn't 404. Code-only, no migration. Unit tests cover the retry,
  the non-cart_hash 23505, and the retry-failure path.

### 3. Capped-rental modifiers / Office Ally 837P / G47.33

- Modifier rotation logic is **present and CMS-correct**
  (`lib/resupply-domain/src/capped-rental.ts`): month 1 `RR,KH`; months 2–3
  `RR,KI`; months 4+ `RR,KJ`; `KX` added on 4+ when compliant for
  `E0601/E0470/E0471`. Tested (`capped-rental.test.ts`).
- Rental month is tracked atomically in `capped_rental_cycles` (migration 0134)
  with a 30-day anniversary rule (`decideCappedRentalAdvance()`).
- 837P builder is complete (`lib/resupply-integrations-office-ally/src/edi/837p.ts`),
  diagnosis codes normalized (`G47.33` → `G4733`), modifiers emitted per service
  line in the SV1-01 composite. Manual/admin submit flow with atomic preflight
  in `artifacts/resupply-api/src/lib/billing/office-ally-batch.ts`.
- **Gap A — seeded payer rules:** the `payer_modifier_rules` rule engine
  (`resolveModifiersFromRules()`, migration 0130) exists but launch-payer rows
  must be seeded. → **migration `0474`**.
- **Gap B — G47.33 silent fallback: CLOSED.** `office-ally-batch.ts` used to
  default the diagnosis to `G47.33` when no sleep study existed. It now fails
  the preflight with `claim_missing_required_data` and names the missing field
  (`missing: "diagnosis_icd10"`) plus an operator-facing message, instead of
  auto-stamping an assumed dx — a wrong/assumed diagnosis drives denials like
  wrong modifiers do.

  The same fallback existed in **two** other places, both fixed with it. A
  first pass at this note claimed the gap was closed while the third site was
  still live — the guard was only ever as strong as its least-guarded caller,
  which is worth remembering before marking anything here closed.
  1. `prescription-request-builder.ts` stamped `["G47.33"]` onto a
     prescription-request packet that is **faxed to a prescriber to sign**, so
     an unsourced diagnosis could become attested clinical documentation — and
     that document is what justifies billing. It now returns
     `rx_missing_diagnosis`; the auto-draft worker counts those in their own
     `skipped_no_diagnosis` bucket rather than as failures, so the daily
     number reads as "N patients need a sleep study attached".
  2. `routes/patients/insurance-claims-ai.ts` (auto-fix-and-resubmit) builds
     its 837P directly through `adapter.submitClaims` rather than
     `buildOneDetail`, and hardcoded `diagnosisCodes: ["G47.33"]` — so an
     assumed diagnosis could still reach a payer on the resubmit path after
     the batch builder started refusing them. It now resolves the recorded
     diagnosis and refuses the resubmit without one.

  All three resolve the code through the shared `parseRecordedIcd10`
  validator (`lib/billing/coverage-diagnosis.ts`), which accepts the dotted
  and undotted spellings and the alphanumeric extensions real ICD-10-CM codes
  carry, and treats an unusable value the same as a missing one. A failed
  lookup is reported separately from an absent diagnosis, so a database
  outage is never filed as "this patient needs paperwork".

- **External gates (cannot be satisfied from the repo):**
  - ~~DMEPOS sign-off (human/out-of-band)~~ — **done.** Confirmed complete by
    the business owner on 2026-08-21. Recorded here so the gate isn't
    re-raised; the repo has no way to observe it.
  - Office Ally **sandbox** acceptance of a real 837P (999/277CA) — still
    open, and the last remaining gate on flipping e-claims live. Local EDI can
    be generated/inspected meanwhile via stub mode (`OFFICE_ALLY_STUB=1` →
    `OFFICE_ALLY_FILE_OUTBOX_DIR`).

### 4. Voice inbound CallSid binding — real, medium

- Outbound binds CallSid post-dial via `attachCallSid()`; **inbound never stamps
  it into the pending session** (`artifacts/resupply-api/src/routes/voice/inbound-reorder.ts:473`),
  so `twilioCallSid` is `null` until the Twilio `start` frame arrives
  (~100–500 ms).
- Concrete risk: inbound IVR analytics update `voice_reorder_sessions` keyed by
  `.eq("twilio_call_sid", null)` in that window; no validation that the
  `start`-frame CallSid matches the pending entry
  (`artifacts/resupply-api/src/lib/voice/ws-handler.ts:851`).
- **Fix:** pass `req.body.CallSid` into the inbound `register()`, add a
  `start`-frame mismatch guard, log `attachCallSid` failures. Code-only, no
  migration.

### 5. markPaid refunded→paid — real (narrow), now fixed

- Initial triage was wrong: it conflated `markStatus` (guarded —
  `status='pending'` only) with `markPaid`, which was **unguarded**. `markPaid`
  runs for BOTH `checkout.session.completed` and
  `checkout.session.async_payment_succeeded` (distinct event ids, not collapsed
  by the `stripe_webhook_events` id-dedup), and its `upsert(status:"paid")`
  had no status filter — so a dashboard "Resend" / very delayed retry of
  `completed` landing AFTER a `charge.refunded` would flip `refunded → paid`.
- **Fix:** guarded write in
  `artifacts/resupply-api/src/lib/stripe/webhook-handlers/checkout-session.ts` —
  UPDATE excludes `status='refunded'`; a missing row still INSERTs (crash
  recovery); concurrent-insert race (23505) re-reads. Code-only, no migration.
  Regression test locks all three paths.

### 6. Refund restock — decided: keep CSR-return-only

- Stripe `charge.refunded` does **not** auto-restock; only CSR-marked returns
  with `restock:true` do (`artifacts/resupply-api/src/lib/shop-returns/restock.ts`),
  reconciled by the monthly inventory count. **No code change** — working as
  designed per operator decision.

### 7. Fail-open reservation / counter & subscription holds — by design

- Fail-open reservation is intentional and documented
  (`artifacts/resupply-api/src/lib/inventory/reservations.ts:20-32`); only a
  clean oversold RPC verdict blocks the sale. Subscriptions model unlimited
  stock; counter orders bypass Stripe checkout entirely. No action.

## Sequenced plan

**Phase A — code-only, no external dependency (one PR):**

1. `cart_hash` 500 guard + unit test (`shop/checkout.ts:365`).
2. Stripe idempotency key + pre-create existing-sub reuse
   (`platform-billing/stripe.ts:847`). Bounds blast radius even before
   test-mode replay; DB unique indexes are the backstop.
3. Voice inbound CallSid: stamp into `register()`, start-frame mismatch guard,
   log `attachCallSid` failures.
4. Refunded→paid regression test.

**Phase B — capped-rental / Office Ally (code lands now, go-live gated on externals):** 5. Migration `0474`: seed `payer_modifier_rules` for launch payers. 6. ~~G47.33 preflight~~ — **done**: manual submit now fails with
`claim_missing_required_data` when no real `diagnosis_icd10` exists, and the
prescription-request packet builder refuses for the same reason. 7. Validate generated 837P locally via stub mode; then **hold for** DMEPOS
sign-off + Office Ally sandbox acceptance before flipping e-claims live.

**Validation that must happen outside the repo before go-live:**

- Stripe test-mode event-sequence replay for the idempotency fix (#1).
- Office Ally sandbox 837P acceptance (999/277CA) (#3). The DMEPOS sign-off
  that used to sit alongside it is **done** (owner-confirmed 2026-08-21).
- One inbound Twilio test call to confirm CallSid binding (#4).
