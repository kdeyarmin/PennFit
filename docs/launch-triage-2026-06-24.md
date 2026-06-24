# Launch triage — 2026-06-24

Triage of the pre-launch backlog for the single-tenant Penn (CareMetric
Breathe seed tenant) go-live. Scope decided with the operator: AI **voice**
and live **Office Ally e-claims** are in launch scope (live at go-live);
refund restock stays **CSR-return-only**. The multi-tenant worker fan-out and
`resolve_compliance_*` / `acquisition_funnel` org-scoping items are **deferred**
(non-PHI config/analytics bleed, not launch-blocking for single-tenant Penn).

Next available migration number: **`0474`** (`0473` is the current tip).

## Blocking vs. deferred

| #   | Item                                                 | Real bug?            | In-repo fixable            | External gate                | Verdict                             |
| --- | ---------------------------------------------------- | -------------------- | -------------------------- | ---------------------------- | ----------------------------------- |
| 1   | Stripe double-subscription idempotency               | yes (race)           | yes, code-only             | Stripe test-mode replay      | **Launch-blocking**                 |
| 2   | `cart_hash` 500                                      | yes (low-prob)       | yes, code-only             | none                         | **Launch-blocking**                 |
| 3   | Capped-rental modifiers / OA 837P / G47.33 preflight | partial              | seed migration + preflight | DMEPOS sign-off + OA sandbox | **Launch-blocking** (e-claims live) |
| 4   | Voice inbound CallSid binding                        | yes (medium)         | yes, code-only             | Twilio test call             | **Launch-blocking** (voice live)    |
| 5   | markPaid refunded→paid                               | no (already correct) | n/a — add regression test  | none                         | No action (lock with test)          |
| 6   | Refund restock on `charge.refunded`                  | product decision     | n/a                        | none                         | **Decided: keep CSR-return-only**   |
| 7   | Fail-open reservation / counter & sub holds          | no (by design)       | n/a                        | n/a                          | No action                           |

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

### 2. `cart_hash` 500 — real low-probability bug

- `createHash("sha256").update(JSON.stringify(sortedItems))` at
  `artifacts/resupply-api/src/routes/shop/checkout.ts:365` is uncaught; a
  malformed/circular payload 500s instead of returning a 4xx.
- **Fix:** validate item shape (or guard the stringify) before hashing; return a
  client error. Code-only, no migration. Add a unit test.

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
- **Gap B — G47.33 silent fallback:** `office-ally-batch.ts:1266` defaults the
  diagnosis to `G47.33` when no sleep study exists. For manual submit this
  should become a **preflight failure** (`claim_missing_required_data`) rather
  than auto-stamping an assumed dx — wrong/assumed diagnosis drives denials like
  wrong modifiers do.
- **External gates (cannot be satisfied from the repo):** DMEPOS sign-off
  (human/out-of-band) and an Office Ally **sandbox** to validate real 837P
  acceptance (999/277CA). Local EDI can still be generated/inspected via stub
  mode (`OFFICE_ALLY_STUB=1` → `OFFICE_ALLY_FILE_OUTBOX_DIR`).

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

### 5. markPaid refunded→paid — not a bug

- No reverse transition exists. Full refund → terminal `refunded`; partial
  refund leaves `paid`; `markStatus` filters `status='pending'` only
  (`artifacts/resupply-api/src/lib/stripe/webhook-handlers/checkout-session.ts`).
- **Action:** add a regression test to lock the terminal behavior.

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

**Phase B — capped-rental / Office Ally (code lands now, go-live gated on externals):** 5. Migration `0474`: seed `payer_modifier_rules` for launch payers. 6. G47.33 preflight: fail manual submit with `claim_missing_required_data` when
no real `diagnosis_icd10` exists (stop silent fallback). 7. Validate generated 837P locally via stub mode; then **hold for** DMEPOS
sign-off + Office Ally sandbox acceptance before flipping e-claims live.

**Validation that must happen outside the repo before go-live:**

- Stripe test-mode event-sequence replay for the idempotency fix (#1).
- Office Ally sandbox 837P acceptance (999/277CA) + DMEPOS sign-off (#3).
- One inbound Twilio test call to confirm CallSid binding (#4).
