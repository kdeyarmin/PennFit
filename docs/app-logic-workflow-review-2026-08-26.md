# App logic & workflow review — 2026-08-26

A **code-grounded** logic and workflow review of CareMetric Breathe
(repository codename PennFit) at current `main`. Method: architecture /
hard-rule sweeps, then end-to-end traces of every major product domain
against the live route, worker, and SPA paths (file:line evidence). This
is a correctness / completeness review, not a visual redesign pass.

**Prior art consulted** (not re-litigated unless still open on main):

- [`complete-domain-review-2026-06-20.md`](./complete-domain-review-2026-06-20.md)
- [`app-review-domain-workflows-2026-06-24.md`](./app-review-domain-workflows-2026-06-24.md)
- [`superpowers/specs/2026-08-23-comprehensive-application-audit-design.md`](./superpowers/specs/2026-08-23-comprehensive-application-audit-design.md)
- Hard rules in `CLAUDE.md` + `pennfit-rules` skill

**Static gates on this pass:** `check-resupply-architecture.sh`,
`check-admin-route-gates.sh`, `check-resupply-migration-prefix.sh` all
**PASS**. Hard-rule greps (image logging, `req.body` logging, encryption
keys, password pepper, `audit_log` readers, SendGrid bypass, admin
`@theme`, worker `process.exit`, health check path) show **no active
violations**.

---

## Executive summary

The platform has a coherent architecture (insurance-only storefront, CSR
signature orders, PacWare as warehouse SoR, Office Ally RCM, multi-tenant
org scoping on authenticated admin paths, fail-closed lead-capture fitter).
The **happy paths that operators already seed by hand** mostly work.

Two structural gaps dominate:

1. **The resupply automation funnel has no production writer for
   `episodes`.** Reminders, escalations, SMS/email/voice confirm, and
   PacWare "ready to sync" all _consume_ episodes. Nothing in app code
   _creates_ them (patient create, prescription create, CSV import,
   PacWare import, workers). New tenants / new patients never enter the
   ladder unless rows are inserted out of band.
2. **Several multi-tenant and status-derivation mismatches** leave
   second-tenant and post-ERA paths silently wrong (voice confirm
   missing `orgId`, fax auto-file/bill-hold cross-tenant, secondary COB
   rejecting `partially_paid`, claims stuck in `submitting`).

Everything else is either intact, fail-soft by design, or UX residue
from the cash-pay removal.

### Severity counts (this pass)

| Sev        | Count | Theme                                            |
| ---------- | ----- | ------------------------------------------------ |
| Critical   | 2     | Episode lifecycle incomplete                     |
| High       | 10    | Cross-tenant / broken handoffs / status machines |
| Med        | 12    | Dead ends, residue, soft fail-open               |
| Low / Info | many  | Comment drift, intentional fail-soft             |

---

## Domain maps (as coded today)

### 1. Mask fitter → fit request → dispense

```
Population gate → measure (browser-only frames)
  → /api/fit/assess (clinical) or /api/recommend (legacy)
  → /results → /fit-request (lead_capture_only ON by default)
  → POST /shop/fitter-requests (HMAC invite + DB dedupe)
  → /admin/fitter-requests → close fulfilled
  → markFitSessionDispensedById (dispensed_at + ordered_mask_model_id)
```

**Intact:** adult/child gate with no escape; images never leave the
browser; lead-capture fails toward ON (`enabled || degraded`) on both
SPA and `POST /api/orders` (409); dedupe is DB-arbitrated (migration
0519); unmarked catalog service line defaults to adult; clinical
pediatric catalog seed exists.

**Broken / incomplete:**

| Sev  | Finding                                                                        | Evidence                                                                                              |
| ---- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| High | Admin can close with empty `closed_outcome` → dispense stamp never runs        | `admin-fitter-requests.tsx` (~498–503); stamp gated on `fulfilled` in `fitter-requests.ts` (~378–420) |
| High | Legacy `/api/recommend` clears `fitSessionId` → fulfilled close cannot stamp   | `results.tsx` (~325–332); `markFitSessionDispensedById` requires `fit_session_id`                     |
| Med  | Stamp failures swallowed; CSR sees successful close                            | `fitter-requests.ts` (~389–402) `.catch(() => ({ stamped: false }))`                                  |
| Med  | API defaults omitted `population` to `"adult"` (SPA guards mitigate)           | `recommend.ts`, `fitter-request.ts` Zod `.default("adult")`                                           |
| Low  | Stale comment in `refit-campaign.ts` claims dispense columns are never written | Writers exist since 0519                                                                              |

### 2. Resupply automation (due → remind → confirm → fulfill → claim)

```
[episodes must already exist]
  → reminders.scan (hourly) / escalation-scan (daily)
  → SMS / email / optional voice
  → YES / signed link / voice tool → placeResupplyOrderForConversation
  → episode confirmed + fulfillments queued + adjustStock
  → CSR createClaimFromFulfillment → OA 837P batch
  → PacWare CSV export of confirmed episodes (manual)
```

**Intact:** confirm path is idempotent (conditional episode claim +
existing-fulfillment re-check); SMS confirm/STOP threads `orgId`
(prior High fix still holds); stock moves only through `adjustStock`
RPC and is fail-soft on unknown SKU; no patient Stripe charge on
confirm; MessageSid replay guard on inbound SMS.

**Broken / incomplete:**

| Sev          | Finding                                                                                                                                                                                                                                               | Evidence                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Critical** | **No production `.insert` into `episodes`** anywhere under `artifacts/` / `lib/` / `scripts/` (non-test). Patient create, prescription create, CSV import, PacWare import do not open episodes. Reminder scan only considers existing in-funnel rows. | Repo-wide grep; `reminders.ts` (~557–563); `prescriptions-create.ts`          |
| **Critical** | Confirm flips episode to `confirmed` and never opens a next-cycle `outreach_pending` episode → automation is one-shot                                                                                                                                 | `order-flow.ts` (~450–456); `IN_PROGRESS_EPISODE_STATUSES` in `reminders.ts`  |
| High         | SMS (and implied voice) **decline** closes the _conversation_ only; episode stays `outreach_pending` / `awaiting_response` → re-enters ladder after quiet period. Docs claim decline removes the episode.                                             | `sms/inbound.ts` (~1167–1176); `docs/resupply-reminder-algorithm.md` §decline |
| High         | Voice `placeResupplyOrder` calls `placeResupplyOrderForConversation` **without `orgId`** → seed-org fallback; non-seed tenant voice confirm fails with `conversation_not_found`                                                                       | `voice/tools-impl.ts` (~826–839); `order-flow.ts` (~194–196)                  |
| High         | Due math uses `MAX(shipped_at)`; resupply only writes fulfillments as `queued` and PacWare never callbacks ship → cadence anchors on `prescription.created_at`                                                                                        | `reminders.ts` (~604–635, ~752–754); `order-flow.ts` (~678–686)               |
| Med          | Documented `awaiting_response` status is never written in production                                                                                                                                                                                  | status filter lists it; no writer                                             |
| Med          | Entitlement/coverage/refill guards fail open on read errors (intentional "don't strand patient", tension with claim correctness)                                                                                                                      | `order-flow.ts` (~271–441)                                                    |
| Med          | Claim creation is manual after confirm (correct for insurance, easy to misread as "confirmed = billed")                                                                                                                                               | `create-claim-from-fulfillment` / OA batch                                    |

### 3. CSR order + signature

```
Admin CSR order OR resupply-draft approve
  → csr_order_requests + HMAC /order-sign
  → patient signs (no card)
  → dispenseSignedCsrOrder → fulfillments (only if draft-linked)
  → biller creates claim from fulfillment (separate step)
```

**Intact:** `/order-sign` collects signature only; checkout/pay routes
404; `csr-orders.no-charge.test.ts` pins the invariant; draft-approve
path back-links and creates queued fulfillments + stock adjust.

**Gaps:**

| Sev | Finding                                                                                              | Evidence                                          |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Med | Ad-hoc (hand-built) CSR orders stop at `signed` — no patient_id/SKU → no fulfillment/claim by design | `dispense-on-sign.ts` (~14–26)                    |
| Med | Therapy-resupply / Orders UI still says "sign & pay" / "pay by card"                                 | `admin-therapy-resupply.tsx`, `fitter-orders.tsx` |
| Low | Marketing pages still describe plans/autopay/checkout                                                | `breathe-features.tsx`, revenue-cycle pages       |

### 4. Billing / RCM

```
Eligibility 270/271 → draft claim → submitting lock → 837P
  → 277CA accepted/rejected → 835 ERA (paid / partially_paid / …)
  → secondary COB worklist → secondary draft
```

**Intact:** concurrent submit race uses `submitting` claim lock; ERA
reconciler receives `orgId` from inbound poll; `bill_hold` gates submit
(not `needs_clinical_review` — that is fitter/catalog only); platform
Stripe is SaaS-only (`STRIPE_PLATFORM_*`, single platform webhook).

**Broken / incomplete:**

| Sev  | Finding                                                                                                                                                        | Evidence                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| High | Secondary COB worklist/auto-workflow select `paid` **and** `partially_paid`, but `deriveSecondaryCob` requires exact `paid` → typical ERA outcomes never draft | `secondary-claims.ts` (~62–64); `auto-workflow-engine.ts` (~437–438); `lib/resupply-domain/src/secondary-cob.ts` (~80–82) |
| High | Claim status machine / ERA map omit live `submitting` → crash mid-upload leaves claims stuck; admin PATCH cannot release                                       | **Shipped** — admin `submitting→draft` + ERA map; worker `billing.claims-submitting-watchdog` auto-releases abandoned locks (skips transmitted) |
| Med  | `eligibility-verifier` / `era-reconciler` default `orgId` to seed if caller omits (live callers pass it; footgun for new sites)                                | `eligibility-verifier.ts` (~123–125); `era-reconciler.ts` (~116–118)                                                      |
| Low  | Denied-primary COB explicitly unfinished                                                                                                                       | `secondary-cob.ts` comments                                                                                               |

### 5. Multi-tenant branding, fax, messaging, platform billing

| Sev  | Finding                                                                                                                                                                                          | Evidence                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| High | Platform host (`cmbreathe.com`) `GET /api/company-info` and storefront `/api/chat` use `resolveOrgIdByHost` → **seed (Penn) brand**. Auth email already avoids this via `resolveBrandingByHost`. | `company-info.ts` (~28–29); `chat.ts` (~478–484); contrast `auth-email-brand.ts` |
| High | Fax barcode auto-file checks `isFeatureEnabled("fax.auto_file_signed")` with **no orgId** (seed flag only) while ingest is per dialed-number tenant                                              | `ingest-inbound.ts` (~233–234) vs referral review which passes `orgId` (~271)    |
| High | `autoMatchInboundFaxToPaperwork` matches outstanding paperwork by fax E.164 with **no `org_id` filter** → cross-tenant bill-hold release risk                                                    | `bill-hold.ts` (~587–591); call at `ingest-inbound.ts` (~259)                    |
| Med  | Provider MFA TOTP issuer always `resolveSeedOrgId()` despite comment claiming tenant scope                                                                                                       | `provider/mfa.ts` (~141, ~206)                                                   |
| Med  | Payment wall is one-shot unlock; `invoice.payment_failed` / subscription deleted do not re-set `billing_required`; wall only wraps `requireAdmin` (storefront/workers ungated)                   | `platform-billing/stripe.ts`; `requireAdmin.ts` / `product-scope.ts`             |
| Med  | Chatbot PII scrub covers phone/email/SSN/DOB/ids only — names, addresses, clinical free text still reach the model                                                                               | `chatbotPii.ts` (~12–18)                                                         |

**Intact:** `NON_INHERITABLE_TENANT_KEYS` for assistant names; email
auto-reply confidence gate; Stripe Connect/patient webhooks removed;
patient packet signed-link org scoping; provider detail/sign is
row-owned.

### 6. Hard rules & boot contract

| Rule                                              | Status                                   |
| ------------------------------------------------- | ---------------------------------------- |
| No image logging                                  | Pass                                     |
| No order `req.body` logging                       | Pass (`pino-http` serializers omit body) |
| No column encryption / pepper / audit_log readers | Pass (comments/tests only)               |
| Email via shared SendGrid client                  | Pass                                     |
| Admin theme scoped (no global `@theme`)           | Pass                                     |
| Health check = `/resupply-api/healthz`            | Pass                                     |
| Stock via `adjustStock` only                      | Pass                                     |
| Patients insurance-only (route layer)             | Pass; copy/schema residue remains        |
| `fitter.lead_capture_only` fail-closed            | Pass                                     |

---

## Cross-cutting patterns

1. **Consume-without-produce lifecycle** — episodes, and to a lesser
   degree next-cycle reopen + ship closeout, are designed end-to-end in
   docs/UI but lack writers.
2. **Status enum drift** — `partially_paid` / `submitting` /
   `awaiting_response` exist in some layers and are ignored or rejected
   in others.
3. **Seed-org footguns on detached paths** — voice confirm, fax flag,
   company-info/chat on platform host, provider MFA issuer. Authenticated
   admin paths are generally correct.
4. **Fail-soft vs fail-closed inconsistency** — lead-capture and magnet
   screening fail closed (good); entitlement/coverage and stock fail
   open (shipping bias); decline fails soft into re-outreach (bad).
5. **Cash-pay residue** — no live Checkout path, but voice prompts,
   shop comments, therapy UI, and marketing still speak "card on file" /
   "pay".

---

## Recommended remediation order

1. **Episode factory** — on active prescription create (and PacWare /
   CSV import fill), open an `outreach_pending` episode with `due_at`
   from cadence; on confirm+ship (or confirm alone as interim), open the
   next cycle. Without this, the reminder product does not run for new
   data.
2. **Decline → episode `declined`** (SMS + voice + email if added) so
   the ladder stops as documented.
3. **Thread `orgId` into voice `placeResupplyOrder`** (dispatcher
   already has it).
4. **Secondary COB accept `partially_paid`** (or stop selecting it in
   worklists).
5. **`submitting` escape hatch** — **shipped** (admin `submitting→draft`,
   ERA map, `billing.claims-submitting-watchdog`).
6. **Fitter close requires `closed_outcome`**; surface
   `dispenseStamped` to UI; optional lightweight `fit_sessions` row on
   legacy path.
7. **Platform-host branding** — company-info + chat should use
   `resolveBrandingByHost` / platform identity, matching auth email.
8. **Fax auto-file + bill-hold** — pass ingest `orgId` into the feature
   flag and paperwork match filter.
9. **Copy sweep** — remove patient "pay by card" / cash-pay language
   from admin + marketing surfaces that contradict the insurance-only
   hard rule.

---

## What this review did not do

- Full `pnpm test` / `pnpm build` suite (Node in this environment is
  v22; repo pins 24 — architecture gates were run instead).
- Live browser click-through against local Supabase or production.
- Exhaustive re-audit of every UX friction item from the 2026-06-24
  domain workflows review (UUID pickers, dead-end surfaces) — those
  patterns remain relevant but are UX leverage, not new correctness
  defects.

---

## Appendix — key file index

| Domain       | Entry points                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fitter       | `artifacts/cpap-fitter/src/pages/{questionnaire,results,fit-request}.tsx`, `routes/storefront/{recommend,fit-assess,orders}.ts`, `routes/shop/fitter-request.ts`, `routes/admin/fitter-requests.ts`, `lib/fitting/order-link.ts` |
| Resupply     | `worker/jobs/{reminders,reminder-escalation}.ts`, `lib/messaging/order-flow.ts`, `routes/sms/inbound.ts`, `routes/email/click.ts`, `lib/voice/tools-impl.ts`, `lib/catalog/{dispense,store}.ts`                                  |
| CSR          | `routes/storefront/csr-orders.ts`, `lib/csr-order/*`                                                                                                                                                                             |
| Billing      | `lib/billing/{eligibility-verifier,office-ally-batch,era-reconciler,auto-workflow-engine}.ts`, `lib/resupply-domain/src/secondary-cob.ts`                                                                                        |
| Fax          | `lib/fax/ingest-inbound.ts`, `lib/billing/bill-hold.ts`                                                                                                                                                                          |
| Brand / chat | `routes/storefront/{company-info,chat,storefront-branding}.ts`, `lib/auth-email-brand.ts`                                                                                                                                        |
| Platform pay | `lib/platform-billing/stripe.ts`, `middlewares/requireAdmin.ts`, `lib/product-scope.ts`                                                                                                                                          |
