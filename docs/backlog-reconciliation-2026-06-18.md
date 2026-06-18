# Backlog reconciliation — 2026-06-18

**Purpose.** The improvement docs under `docs/` (production-readiness,
efficiency audits, growth/compliance reviews, May–June 2026) accumulated a
large catalogue of "gaps" and "future work." Several have since been shipped
without the source docs being updated, so the catalogue had drifted from
reality and could no longer be trusted as a to-do list. This document
reconciles every actionable item against the **current code** (as of
`main` @ `58df702a`) and records a DONE / PARTIAL / OPEN verdict with a
code reference — repo-relative `path:line` where a single site applies, or
a table / migration / route name where the evidence spans several files.

**Method.** Each item was verified by inspecting the actual route, worker
job, migration, or middleware — not by re-reading the originating doc.
Spot-checks that triggered this pass: the audits flagged "no HTTP
compression" (already wired at `app.ts:93`) and "therapy clients have no
HTTP timeouts" (already use `AbortSignal`), both of which were stale.

**Headline.** Of ~38 catalogued items, the large majority are already
shipped — including most of the "P0 revenue-cycle" items (271 ingestion,
DaVinci PAS, A/R aging, denial worklist, outbound fax). The genuinely-open
set is ~12 items, concentrated in **fulfillment last-mile automation**,
**test coverage**, and a smaller **performance / correctness** cluster
(JS-side aggregation caps). Treat the source docs as largely historical —
but the performance/correctness rows below carry forward real open items
from the audits, so don't discard those before they ship.

---

## Already shipped (doc-flagged but DONE — stop tracking)

| Item (per docs)                      | Source doc                          | Evidence                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP response compression            | backend-dme-efficiency-audit (§2.1) | `artifacts/resupply-api/src/app.ts:93` `app.use(compression())`                                                                                                                                                             |
| Therapy-cloud client HTTP timeouts   | app-review-2026-05-13 (N1)          | `signal: AbortSignal.timeout(timeoutMs)` — `lib/resupply-integrations-airview/src/client.ts:116`, `lib/resupply-integrations-care-orchestrator/src/client.ts:59`, `lib/resupply-integrations-react-health/src/client.ts:70` |
| MFA recovery-code atomicity (TOCTOU) | app-review-2026-05-13 (N2)          | `artifacts/resupply-api/src/lib/auth-deps.ts:491` single compare-and-set `UPDATE … WHERE code_hash=? AND used_at IS NULL`                                                                                                   |
| CSRF on storefront mutations         | app-review-2026-05-13 (P1.3)        | `artifacts/resupply-api/src/routes/storefront/orders.ts:48` `requireCsrfWhenSession`                                                                                                                                        |
| Billing query indexes                | backend-dme-efficiency-audit (§2.3) | `lib/resupply-db/drizzle/0208_insurance_claims_billing_indexes.sql` (status/decision_at, submitted_at)                                                                                                                      |
| Explicit dual-stack host bind        | railway-hosting-review (R3)         | `artifacts/resupply-api/src/index.ts:320` `HOST="::"`                                                                                                                                                                       |
| Unified admin rate-limit middleware  | app-review-2026-05-13 (P0.7)        | `artifacts/resupply-api/src/middlewares/admin-rate-limit.ts:96` `adminRateLimit()` factory                                                                                                                                  |
| Per-tenant payer credentials         | multi-tenant-remaining-work-plan    | `artifacts/resupply-api/src/lib/billing/identity-resolver.ts:58` org-scoped, fails closed for unconfigured tenants (shipped in #1108)                                                                                       |
| SPA component decomposition          | app-review-2026-05-13 (P2)          | `artifacts/cpap-fitter/src/pages/account.tsx` + `artifacts/cpap-fitter/src/pages/admin/patient-detail.tsx` each import 20+ section/tab components                                                                           |
| 271 eligibility response ingestion   | backend-dme-efficiency-audit (§4.1) | `artifacts/resupply-api/src/worker/jobs/office-ally-inbound-poll.ts:814` `dispatch271()`                                                                                                                                    |
| DaVinci PAS prior-auth wired         | backend-dme-efficiency-audit (§4.2) | `artifacts/resupply-api/src/routes/admin/davinci-pas-submit.ts:52` calls `submitPasBundle()`                                                                                                                                |
| A/R aging / DSO dashboard            | backend-dme-efficiency-audit (§4.3) | `artifacts/resupply-api/src/routes/admin/billing-reports.ts:34,109` aging-report + dso-by-payer                                                                                                                             |
| Denial worklist                      | backend-dme-efficiency-audit (§4.4) | `artifacts/resupply-api/src/routes/admin/denials-worklist.ts`                                                                                                                                                               |
| Outbound fax (appeals / Rx requests) | app-review-customer-growth… (C-B1)  | `lib/resupply-telecom/src/telnyx-fax.ts` → `routes/admin/claim-appeals.ts:307`                                                                                                                                              |
| Acquisition-funnel dashboard reader  | app-review-customer-growth… (G1)    | `/admin/analytics/acquisition-funnel` route + SPA page, RPC mig 0254                                                                                                                                                        |
| Per-payer compliance rules           | growth-compliance-review (Lever 2)  | `compliance_rules` table + resolver, mig 0212                                                                                                                                                                               |
| Patient dedup / merge workflow       | backend-dme-efficiency-audit (§5.1) | RPCs migs 0225/0229; `/patients/duplicates`, `/patients/merge`                                                                                                                                                              |
| Deadline-aware compliance outreach   | growth-compliance-review (Lever 4)  | `worker/jobs/therapy-setup-deadline-outreach.ts`, registered in `worker/index.ts`                                                                                                                                           |
| Auto-reminder enrollment (cash-pay)  | growth-compliance-review (B-1)      | seeded ENABLED in mig 0325 (was off in 0174)                                                                                                                                                                                |

---

## Genuinely open (the trustworthy to-do)

### Cluster A — Fulfillment "last-mile automation" (highest revenue leverage)

The app surfaces the signal but does not act on it automatically.

| Item                            | Evidence                                                                                                 | Notes                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Resupply-eligible → draft order | `routes/admin/therapy-resupply.ts:216` lists due items; no batch order-create                            | Every order is a manual CSR click; biggest recurring-revenue lever |
| Inventory reservation           | no `inventory_reservations` table; stock is `shop_products.metadata.stock_count` (Stripe, point-in-time) | Oversell risk under concurrency                                    |
| Backorder auto-clear on restock | `routes/admin/shop-backorders.ts:180` manual-clear only                                                  | No restock signal handler                                          |
| Batch claim **creation**        | `fulfillment-to-claim.ts:62` one claim per fulfillment                                                   | Batch 837P **submit** exists; batch **create** does not            |
| Carrier tracking webhook ingest | `shipped_at`/`delivered_at` admin-stamped; no EasyPost/Shippo handler                                    | No auto-advance of fulfillment state                               |

### Cluster B — Test coverage

| Item                                                            | Evidence                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No tests on `routes/admin/patient-packets.ts` (~1.5k LOC)       | state machine + token substitution + multi-channel delivery                                                              |
| No tests on `routes/admin/provider-esign.ts` (~1.1k LOC)        | e-signature / regulatory-adjacent                                                                                        |
| No tests on `routes/patients/insurance-claims-ai.ts` (~969 LOC) | unmonitored Claude spend + error paths                                                                                   |
| No checkout / fitter→order e2e happy-path                       | `e2e/tests` has smoke/a11y/results/admin only                                                                            |
| 4 soft-gated CI jobs not yet required                           | `.github/workflows/ci.yml` `integration`/`a11y`/`e2e-dev`/`e2e-admin` are `continue-on-error: true` — promote once green |

### Cluster C — Performance / correctness (carried forward from the audits)

| Item                                      | Evidence                                                                                                                                                            | Notes                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| JS-side aggregation caps                  | `routes/admin/analytics.ts:138,150,159,186`, `routes/admin/billing-director.ts:110`, `routes/admin/ltv-cac.ts:75,96` use `.limit(20000/50000)` then aggregate in JS | Silent truncation past the cap; move into SQL RPCs (backend-dme-efficiency-audit §2.5) |
| `metrics-snapshot` revenue read unbounded | `worker/jobs/metrics-snapshot.ts:131` selects paid `shop_orders` with no `.limit()`/`.range()` and sums `amount_total_cents` in JS                                  | Risks revenue undercount + perf at high paid-order volume (performance-review §2)      |

### One-offs

| Item                                     | Evidence                                                                                                         | Notes                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `count:'exact'` on hot dashboards        | 106 across 46 admin files vs 7 `'estimated'`; hottest: `inbox-counts.ts`, `ops-status.ts`, `billing-director.ts` | Switch to `'estimated'` where the exact total isn't user-visible |
| RBAC `requirePermission` tail            | ~32/213 admin route files still `requireAdmin`-only (`mfa.ts`, `team.ts`, …)                                     | Finish fine-grained rollout (85% done)                           |
| NPS→review / referral→reward closed loop | capture + attribution exist; conversion/reward measurement does not                                              | growth-compliance-review (G7)                                    |
| Clinical encounters in unified timeline  | conversations are unified; `clinical_encounters` still separate (`/admin/patients/clinical-encounters/query`)    | app-review-customer-growth… (C-R2)                               |
| Cart-abandonment cron                    | built + flag on; cron itself env-gated off (`RESUPPLY_CART_ABANDONMENT_CRON_ENABLED`)                            | Flip + consent decision                                          |

### Partial

| Item                 | State                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Secondary/COB claims | auto-**draft** exists (`billing.auto_secondary_claims`); auto-**submit** does not                        |
| Appeals tracking     | appeal **letters** tracked (`claim_appeal_letters`, mig 0137); no `responded_at`/`outcome`/aging columns |

---

## Out of scope from the repo

| Item                                         | Why                                                                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prod-DB schema drift (Tiers 1–3)             | Verifiable only against the production database, not the repo                                                                                                                       |
| Patient-search trigram index                 | **Blocked by policy** — the DB ships no extensions (no `pg_trgm`); needs a normalized search-column approach, not a GIN index (see note in `0229_patient_duplicate_groups_rpc.sql`) |
| Cloudflare cache-TTL / `trust proxy`         | Operator-side dashboard config (railway-hosting-review R7)                                                                                                                          |
| Migration journal "drift" (52 vs 180+ files) | By design — journal is frozen per `CLAUDE.md`; not a bug                                                                                                                            |

---

## Recommendation

Prioritize by leverage:

1. **Resupply-eligible → draft/batch order** (Cluster A) — converts an
   existing "who's due" worklist into recurring revenue; gate behind an
   entitlement/flag.
2. **`count:'exact'` audit** (one-off) — safe, fast, measurable latency win
   on hot admin views.
3. **Tests for the three large untested routes + a checkout e2e**
   (Cluster B), then promote the soft-gated CI jobs to required.

Everything above is verified against `main` @ `58df702a`. When an item here
is shipped, update this file rather than the (now-historical) source docs.
