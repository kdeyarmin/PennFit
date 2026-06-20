# Domain-layer review — gaps & enhancement opportunities (2026-06-20)

A thorough review of the application's **domain logic** — the pure,
side-effect-free business rules that decide eligibility, timing, money,
and compliance. The lens is deliberately narrow and code-level: not
"what features are missing" (the `app-review-*` / `feature-gaps-*` docs
already cover product breadth) but **"where do the rules live, are they
correct, and are they reusable?"**

Scope reviewed:

- `lib/resupply-domain/src/**` — the canonical pure package (ADR 008:
  zod + TS only, no I/O; enforced by `scripts/check-resupply-architecture.sh`
  Rule 2).
- `artifacts/resupply-api/src/lib/billing/**`,
  `.../lib/clinical/**`, and assorted worker jobs — where a large amount
  of pure regulatory logic *actually* lives today.

---

## 1. Headline finding: the domain layer is split across two homes

`lib/resupply-domain` is the *declared* home for pure business rules,
and it is excellent — ten small, well-commented, well-tested modules
(`entitlement`, `refill-window`, `outreach-plan`, `margin`,
`timely-filing`, `goal-pace`, `ltv-cac`, `metric-threshold`, `phone`,
`us-timezone`) plus `RENEWAL_WINDOW_DAYS`.

But the package only covers **analytics + outreach + one billing rule
(timely-filing)**. The rest of the regulatory vocabulary — the rules
that, when wrong, produce *unappealable Medicare denials* — lives one
layer too low, inside `artifacts/resupply-api/src/lib/billing/**` and
`.../lib/clinical/**`. Those helpers are *importable-pure* (no DB writes
in the hot path), but because they sit in the I/O application artifact
they:

- **cannot be reused by the SPA** for a "why is this blocked / what will
  this claim look like?" preview (the storefront/admin React app can't
  import from `artifacts/resupply-api`),
- **cannot be imported by other workspaces** (worker-only packages, future
  services),
- **are not covered by ADR 008's purity guarantee** — nothing stops a
  future edit from adding a DB call into the middle of the rule, and
- in several cases **have drifted into 2–4 redeclared copies** of the same
  constant (see §2).

The relocation cost is low: the candidate cores depend only on `zod`/TS,
or at most a **type-only** `@workspace/resupply-db` import (a `Database`
/ `OrgScopedClient` row type) that is trivially replaced with a local
interface. `resupply-domain/package.json` has exactly one dependency
(`zod`).

**Recommendation:** treat `lib/resupply-domain` as the single home for
pure rules. New pure rules land there; existing mis-located ones migrate
opportunistically (§4), leaving the DB/PDF/fax wrappers in the API.

---

## 2. Confirmed drift & correctness bugs (fix first — small, high-value)

These are not stylistic. Each is a real defect verified in the tree
today.

### 2.1 `RENEWAL_WINDOW_DAYS` is redeclared, defeating the constant's entire purpose
The domain constant exists *specifically* so the Rx-renewal dispatcher
and the `ops-status` "Eligible now" badge stay in lockstep — its own
header says so (`lib/resupply-domain/src/dispatcher-constants.ts:1-10`).
`ops-status` imports it correctly
(`routes/admin/ops-status.ts:21`), but the dispatcher **redeclares its
own copy** and drives the cutoff math from it:

- `artifacts/resupply-api/src/lib/rx-renewal/dispatcher.ts:45`
  — `export const RENEWAL_WINDOW_DAYS = 30;` (local)
- used at `dispatcher.ts:96, 102, 439`

If anyone ever tunes the window in the domain layer, the dispatcher —
the thing that actually *sends the nudges* — silently ignores the change.
**Fix:** delete the local const, import from `@workspace/resupply-domain`.
Effort: **XS**. Risk: none.

### 2.2 The CMS adherence rule (4h / 21-of-30 nights / 90-day horizon) is implemented 3–4 times
There is a vetted, pure, tested canonical implementation —
`findBestAdherenceWindow` + `COMPLIANT_MINUTES_PER_NIGHT (240)` /
`COMPLIANCE_NIGHT_RATIO (0.7)` / `WINDOW_DAYS (30)` /
`ATTESTATION_HORIZON_DAYS (90)` in
`artifacts/resupply-api/src/lib/compliance-attestation.ts:42-49` — and
five callsites correctly reuse it. But the **same magic numbers and the
same sliding-window count loop are independently re-hardcoded** in:

- `lib/clinical/adherence-predictor.ts:78-79` (`COMPLIANT_MINUTES = 240`,
  `CMS_COMPLIANT_NIGHTS = 21`) + window check at `:188-205`
- `lib/clinical/adherence-features.ts:14-15` (same two consts) + label
  loop at `:143-157`
- `lib/compliance-scanner.ts:86` (`MIN_GOOD_NIGHT_MINUTES = 240`)
- `lib/clinical/sleep-coach.ts:586` (bare `>= 240` literal)

This is the textbook "duplicated + regulatory + denial-risk" profile: a
drift between any two copies yields a *wrong compliance label*, which
drives a wrong claim. **Fix:** promote the canonical
`compliance-attestation` adherence core to
`lib/resupply-domain/src/cms-adherence.ts` (it is already pure), and have
all four callsites import the constants and the window function. Effort:
**M**. Risk: medium (touches the live compliance path — extract with the
existing tests as the safety net).

### 2.3 `entitlement.ts` fails **open** on non-finite / negative inputs
`refill-window` and `timely-filing` both guard `NaN`/`Infinity`/`≤0`
inputs; `resolveResupplyEntitlement` does **not** clamp `minIntervalDays`,
`maxQuantityPerPeriod`, or `periodDays`
(`lib/resupply-domain/src/entitlement.ts:88-118`). A `NaN` interval makes
`eligibleOn` an Invalid Date, so `tooSoon` (`NaN > now`) is `false` →
the patient is silently reported **eligible**; a negative interval pushes
`eligibleOn` into the past → always eligible. Bad reference data
(`hcpcs_codes.min_interval_days`) therefore *authorizes a too-soon
dispense* — the single most common avoidable DME denial, which the module
exists to prevent. **Fix:** clamp the three numeric inputs the same way
the sibling modules do, and add the missing-input test. Effort: **S**.
Risk: low (purely tightening).

### 2.4 `outreach-plan` payer / SKU matching is raw, case- & whitespace-sensitive
`resolveOutreachPlan` compares the **free-text** payer name with a raw
`!==` (`outreach-plan.ts:150-155`) and the SKU prefix with a
case-sensitive `startsWith` (`:138-139`). "Aetna" ≠ "aetna " ≠ "AETNA",
so a frequency rule silently fails to match and the patient quietly falls
back to the prescription's default cadence — a *quiet operational bug*
across the entire rules engine. **Fix:** trim + casefold both sides of
the payer compare (and decide SKU canonicalization policy). Effort: **S**.
Risk: low.

---

## 3. Existing-module enhancements

Per-module, ranked correctness → regulatory accuracy → nice-to-have.
(2.3 and 2.4 above are the two that rise to "bug.")

| Module | Enhancement | Why it matters |
| --- | --- | --- |
| `entitlement` | Accept the earliest in-period dispense date and return `quantityEligibleOn` | The header *admits* it can't date the quantity gate; a `quantity_exceeded` result is currently a dead end instead of "clears Jun 3" for the CSR/patient |
| `entitlement` | Optional `graceDays` to align the interval gate with the refill 10-day ship lead | Today entitlement and `refill-window` can disagree on whether an early ship is allowed |
| `refill-window` | Same-or-similar support (take the **max** last-dispense across related HCPCS); per-payer override of the 14/10 lead constants | CMS refill timing keys off "same or similar," not one family in isolation; lead days vary by payer |
| `refill-window` | Guard non-finite `now` / `lastFulfilledAt`; lock `REFILL_AFFIRMATION_STATEMENT` wording with a test | Consistency with sibling NaN-hygiene; the affirmation is regulatory copy that must not silently change |
| `ltv-cac` | Make LTV **margin-aware** (fold in `margin.ts`) or at minimum document that it uses gross revenue; add CAC payback-period | Using gross revenue as LTV **systematically overstates** LTV:CAC by ignoring COGS the codebase already computes — the headline unit-economics number is wrong in a predictable direction |
| `goal-pace` | Suppress/flag `projectedValue` until ≥ ~20% of the period elapses (or return a confidence signal); clamp negative target/actual; support quarters in `parsePeriodRange` | Day-1 run-rate projects 30× and feeds an owner-facing forecast with no confidence band |
| `timely-filing` | Document/handle the timezone-edge of `asOf` near midnight UTC; note the `Math.round` relies on the date-slice | A one-day slip on a filing deadline is the difference between a payable and an auto-denied claim |
| `metric-threshold` | Decide behavior for a `NaN` current value in `absolute` mode (silently "not breached" today); document the `delta_pct_7d` abs-denominator sign convention; optional N-consecutive-day hysteresis | An alerting system that silently passes on `NaN` hides exactly the breakage it should surface; hysteresis cuts single-noisy-day alert spam |
| `margin` | Add `lossLineCount` / negative-margin revenue to the aggregate | The rollup's "blind spot" story is incomplete without "N lines sold below cost" |
| `phone` | Optional default-region for non-`+` international numbers; reconcile the header's "8–15 digits" claim with the NANP-only no-`+` path | Minor; doc/behavior mismatch today |
| `us-timezone` | The admitted zip-prefix refinement for split-state patients (TN/KY/ID/…); add the untested territory mappings | A minor-side patient can be contacted at the 9am–8pm window edge; still legal but tighter than intended |

**Test holes worth closing alongside:** entitlement non-finite input;
outreach payer case/whitespace; `aggregateMargin` with a loss line;
`metric-threshold` `delta_pct_7d` with a **negative** baseline; `ltv-cac`
within-channel costed+uncosted mix; `refill-window` contact boundary +
affirmation-wording lock; `goal-pace` early-period projection &
target-0 branch.

---

## 4. Domains to build out as new pure modules

Whole regulatory areas whose core rule has no representation in
`lib/resupply-domain`. Ordered by value (regulatory/denial risk +
confirmed scatter first). "Relocate" = the pure core already exists in
the API artifact; "greenfield" = no rule today.

| # | Proposed module | Core rule | Lives today | Type | Effort/Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | `cms-adherence.ts` | 4h/night, ≥21 of 30 nights, first-90-day window (see §2.2) | `lib/compliance-attestation.ts:42` (canonical) + 3 redeclared copies | Relocate + dedup | M / Med |
| 2 | `capped-rental.ts` | 13/36-mo cycle advance (`start + month·30d`), ownership transfer at `max_months+1`, **modifier rotation** (RR always; KH mo 1-3; KI mo 4-13; +KX when compliant & HCPCS∈{E0601,E0470,E0471}) | `lib/billing/capped-rental-advancer.ts:38,118,269` | Relocate core, keep DB writes | M / Med |
| 3 | `same-or-similar.ts` | Medicare 5-year (60-mo) equipment-replacement window → `clear/active/inactive/unknown` + `clearsOn` date | **No rule today** — `routes/admin/same-or-similar.ts:30` only stores a hand-checked status | Greenfield | S / Low |
| 4 | `written-order.ts` | SWO/DWO completeness gate (legal name, DOB, HCPCS, practitioner name + 10-digit NPI) → structured missing-field errors | `lib/swo-pdf.ts:118` (`validateSwoInputs`) | Relocate rule only | S / Low |
| 5 | `authorization-expiry.ts` | Classify PA/DWO/CMN expiry → `ok/expiring/expired` with heads-up windows; **currently two sweeps hardcode different windows** | `worker/jobs/prior-auth-expiry-sweep.ts:69` (30/14/7) and `dwo-expiry-sweep.ts:28` (60/30/7) | Relocate + unify | S / Low |
| 6 | `secondary-cob.ts` | COB roll-down: `contractual = max(0, billed − paid − patientResp)`, secondary-eligibility predicate | `lib/billing/secondary-claim-generator.ts:59` (pure, type-only DB import) | Relocate core | S / Low |
| 7 | `payer-modifiers.ts` | Resolve modifiers from (payer, HCPCS, condition) rules — shares the modifier vocabulary with #2 | `lib/billing/modifier-rules.ts` (type-only DB import) | Relocate (co-locate w/ #2) | M / Med |
| 8 | `eligibility-recheck.ts` | Coverage staleness cadence → `never_verified/terminating_soon/stale(>30d)/ok` + worklist priority | `lib/billing/eligibility-worklist.ts:69` | Relocate | S / Low |
| 9 | `payment-plan.ts` | Installment amortization (even split + remainder to first), summary, status | `lib/billing/payment-plan.ts` (already pure+tested) | Relocate | S / Low |
| 10 | `proration.ts` | `round(deltaMonthlyCents · daysRemaining/periodDays)` partial-period charge | `lib/billing-preview.ts:67` | Relocate / centralize | S / Low |
| 11 | `era-patient-responsibility.ts` | Sum 835 PR-group adjustments by CARC 1/2/3 → deductible/coinsurance/copay | `lib/billing/era-reconciler.ts:467` | Relocate | S / Low |
| 12 | `customer-recency.ts` | Lapsed/winback/active windows (180/365/730d) — **redeclared across two jobs** | `worker/jobs/lapsed-customer-winback.ts:58` & `deductible-reset-push.ts:61` | Relocate + dedup | S / Low |

Additional smaller candidates noted during the sweep: `return-window`
(60-day comfort guarantee + 90-day/3-return auto-approve cap, re-derived
in `routes/shop/my-returns.ts` and `lib/shop-returns/auto-approval-rules.ts`);
`scoreAdherence` progressive-target escalation
(`lib/compliance-scanner.ts:471`, uses the same 240/70% constants as #1);
a `round4` rate-aggregation helper duplicated ~10× in
`lib/analytics/aggregate.ts`.

**Explicitly *not* good fits** (kept out of the pure layer on purpose):
`proxy-chain` (request-echo diagnostics), `adherence-predictions` /
`dispense-readiness` (model-backed I/O — only thin scoring sub-pieces are
pure), `denial-codes` (a CARC/RARC catalog CRUD, not a rule — though a
`mapDenialToAction(carc)` classifier could be a future S candidate),
PDF/fax renderers.

---

## 5. Suggested sequencing

1. **Quick correctness pass (≤ half a day, no behavior risk):** §2.1
   import fix, §2.3 entitlement clamps, §2.4 outreach normalization, plus
   the named test-hole additions. Pure tightening, each independently
   shippable.
2. **De-duplicate the regulatory constants (§2.2 + #1, #5, #12):**
   collapse the redeclared CMS-adherence, auth-expiry, and recency
   windows into single pure modules. This is the highest *risk-reduction*
   per line — it removes live drift between copies.
3. **Greenfield the pre-HETS gap (#3 same-or-similar):** purely additive,
   de-risks the future HETS adapter the route comment anticipates.
4. **Opportunistic relocations (#4, #6, #8, #9, #10, #11):** move pure
   cores from `lib/billing` → `lib/resupply-domain`, re-export from the
   old path so importers don't churn, point the SPA preview at them as
   the reuse payoff lands.
5. **Module enhancements (§3):** entitlement `quantityEligibleOn`,
   margin-aware LTV, goal-pace projection confidence — each a feature in
   its own right.

Steps 1–3 are the ones that change correctness; 4–5 are layering and
capability. None requires a migration or a schema change — this is all
pure-logic refactoring guarded by the existing architecture check and
unit tests.
