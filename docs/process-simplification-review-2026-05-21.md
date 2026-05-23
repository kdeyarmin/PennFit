# Process Simplification & "Smarter Defaults" Review — 2026-05-21

**Branch:** `claude/process-simplification-review-F3jP3`
**Scope:** Sweep every user-facing process (patient storefront, customer
account, admin/staff workflows, backend automation) and surface concrete
ways to either (a) reduce the number of steps/decisions the end user
has to make, or (b) make the system make a smarter automatic decision
on the user's behalf. Each finding cites file:line so reviewers can
drill in.

This document is a **recommendations list**, not a rollout plan; ranking
or sequencing belongs in a follow-up polish-plan revision.

---

## Top-of-list (highest impact / lowest effort)

1. **Drop the second consent moment** on `/order` — patient already
   consented at `/consent`. See [P1](#p1-double-consent).
2. **Pre-fill `/order` for signed-in customers** from `auth.users` +
   last shipping address. See [P3](#p3-no-prefill-on-order).
3. **Auto-detect "manage my reminders" via signed-in session** instead
   of the email-token round-trip. See [P5](#p5-reminders-manage-token).
4. **Auto-send cart-abandonment emails** instead of an admin button.
   See [A1](#a1-manual-cart-abandonment).
5. **Surface "skip" explicitly on the questionnaire** and stop scoring
   skipped answers as `false`. See [P4](#p4-questionnaire-skip-defaults).
6. **Auto-approve low-risk returns** (defects under 7d, sealed under 30d)
   rather than queueing every RMA for staff. See [A4](#a4-rma-rules).

---

## Patient storefront — fitter & order

### P1. Double consent (`/consent` → `/order`) <a id="p1-double-consent"></a>

**Today.** The patient must consent to camera + email at
`artifacts/cpap-fitter/src/pages/consent.tsx:70` (three checkboxes plus
optional phone/SMS) and then *again* to a "contact me about my order"
block at `artifacts/cpap-fitter/src/pages/order.tsx:776-829` (the
checkbox + label that drives the `consentToContact` field, which the
form schema at `:95-97` refines to `=== true` and blocks submit on).
Two consent moments invite mismatch: a patient who unchecks the
order-page box has already opted in upstream — the legal record is
now ambiguous.

**Smarter.** Persist the `/consent` opt-in on the server (already
happens via `submitFitterLead` at `consent.tsx:83`) and treat that row
as the authoritative communication consent. On `/order`, show a single
acknowledgement line ("By submitting this order you confirm the
contact and HIPAA disclosures from the consent page") instead of a
fresh checkbox. Net: one less required interaction at the highest
abandon-risk page.

### P2. SMS opt-in disabled when phone empty <a id="p2-sms-checkbox-disabled"></a>

**Today.** `consent.tsx:333-363` greys out the SMS checkbox until a
valid phone is typed (`disabled={!phoneFilled || !phoneValid}` at
line 345; `checked={smsOptIn && phoneFilled && phoneValid}` at
line 344). A patient who wants to opt in to SMS has to discover the
ordering by trial: they click the disabled checkbox, nothing happens,
they scroll up, type the phone, scroll back, find the box now
enabled, and click it. The funnel-top form makes them do tasks in a
strict order with no on-screen explanation of why.

**Smarter.** Reverse the order: let the patient tick SMS-opt-in
first, then progressively reveal the phone field below it on demand
("We'll need a phone number — enter it below"). The checkbox is the
disclosure of intent; the field collection should follow it, not
gate it.

### P3. `/order` is a long form with almost no pre-fill <a id="p3-no-prefill-on-order"></a>

**Today.** `pages/order.tsx` is 1,011 lines and 18 required fields
across 5 cards. Pre-fill is just `patient.email` from the in-memory
fitter store (`order.tsx:163`). A *signed-in* shopper still types
name, DOB, phone, address, and insurance from scratch — even if they
have prior orders on file.

**Smarter.** When `useShopIdentity().isSignedIn`, hydrate defaults
from `/shop/me` (already used by `/account` — see `pages/account.tsx`)
and the most-recent `shop_orders.shipping_address`. The Zod schema
stays the same; the form just starts mostly-filled. For
guest checkout, optionally probe by email — if the email exists,
prompt "Welcome back — sign in to use saved info" instead of
re-typing.

### P4. Questionnaire `false` ≠ "not answered" <a id="p4-questionnaire-skip-defaults"></a>

**Today.** `pages/questionnaire.tsx` is one-question-per-screen with no
explicit skip. Patients can click Back but not Skip. The client
backfills missing answers to `false`/`"unknown"` in
`artifacts/cpap-fitter/src/pages/results.tsx` (when assembling
`fullAnswers` for the recommend call) BEFORE the request leaves
the browser, so the API receives a payload that looks complete but
isn't — and the recommendation engine treats e.g. an un-answered
"do you breathe through your mouth?" as a non-mouth-breather,
which can recommend a nasal mask that won't seal.

**Smarter.** Two changes at `questionnaire.tsx:163`:
   (1) Add an explicit **"I'm not sure"** tile per boolean question
       (same UI as the existing `unknown` option on `cpapPressureSetting`
       at line 56), and
   (2) Map `unknown`/`null` to a neutral weight in the scoring engine
       (see `lib/resupply-domain` recommendation engine — drop the
       answer from the weighted average rather than treating it as
       false).
Net: better recommendations, less guilt about skipping.

### P5. Reminder management is gated on an emailed token <a id="p5-reminders-manage-token"></a>

**Today.** Subscribing at `/reminders` returns a "check your inbox"
success state (`pages/reminders.tsx:58-61` `SuccessState`). The patient
must open the email and click a single-use token link to reach
`/reminders/manage`. There's no "Manage my reminders" tile on
`/account` for signed-in customers either.

**Smarter.** Two paths, neither destructive:
   (a) If the requester is signed in (`useShopIdentity().isSignedIn`),
       skip the token email and SPA-route directly to
       `/reminders/manage` with the new subscription pre-loaded.
   (b) Add a "Replacement reminders" card to `pages/account.tsx`
       that links to `/reminders/manage` for the signed-in user.
Token email stays as the fallback for guest subscribers.

### P6. Email captured 2–3× across flows <a id="p6-email-everywhere"></a>

**Today.** Email is collected at `/consent`, again at `/order`
(pre-filled but editable), and again at `/insurance/estimate` and
`/reminders` if the patient lands there separately. No single record
of "this device has identified itself as <email>".

**Smarter.** A lightweight `fitter_identity` cookie (or just the
existing `pf_session`) that, once `submitFitterLead` succeeds, makes
the email field on every subsequent storefront form pre-fill +
collapsible ("Sending to you@example.com — change?"). No new schema
required.

### P7. Measurement plausibility is permissive <a id="p7-measurement-plausibility"></a>

**Today.** `PLAUSIBILITY_BOUNDS` in `artifacts/cpap-fitter/src/lib/measure-flow.ts`
accepts nose-width 20–60 mm (a 3× range). Below-confidence retake is
gated on the recommendation engine's confidence (<70 %) at
`pages/results.tsx`, not on measurement plausibility itself. An
implausible-but-not-rejected scan that happens to score a confident
mask gives a confidently-wrong answer.

**Smarter.** Add a soft warning band (e.g. "measurements are at the
extreme of expected — consider retaking") between the strict reject
bounds and the typical-population bounds (~30–45 mm nose width
for adults). Render as a banner above the questionnaire entry with a
**Retake** CTA. Cost: ~30 lines in `measure.tsx`.

---

## Customer account

### C1. `/account` is a single 18-section scroll <a id="c1-account-scroll"></a>

**Today.** `pages/account.tsx` itself is ~595 lines after recent
extractions, but it composes 18 child Section components inline
(`<ProfileSection>`, `<ClinicalInfoSection>`, `<OrdersSection>`,
`<SubscriptionsSection>`, etc. at `account.tsx:277-328`). Customers
must scroll past "profile" to reach "orders" or "subscriptions";
there is no in-page navigation, so locating a specific section on
mobile is a long thumb-scroll.

**Smarter.** Surface a sticky left-rail TOC (or top tabs on mobile)
keyed to the 18 sections. No schema or API change — pure markup +
hash-routing. Could also be the chance to lazy-mount sub-sections so
the first paint of `/account` doesn't render 18 cards at once.

### C2. No proactive reorder-of-the-month <a id="c2-no-reorder-nudge"></a>

**Today.** `/account` has a "reorder suggestions" section per the
overview, but cadence is driven by replacement-reminder subscription
(opt-in). For shop customers who never subscribed to reminders, the
account page suggests but doesn't push.

**Smarter.** When `delivered_at + replacement_interval ≈ now()`,
schedule a single in-app banner ("Time to reorder cushions?") *and*
add the items to a "ready to checkout" cart in localStorage so a click
finishes the order. Doesn't change the underlying reminder cadence —
just makes the existing data actionable from the account page.

### C3. Returns flow lives outside `/account` <a id="c3-returns-discoverability"></a>

**Today.** `/returns` is a public page (`App.tsx:393`) with its own
form. A signed-in customer must navigate away from `/account` to
start a return, and re-type order details the system already has.

**Smarter.** Inline an "Eligible to return" panel on each order card
in the `/account` orders section: one-click "Start return" with
order/SKU pre-populated. The standalone `/returns` page stays for
unsigned/guest users.

---

## Admin & backend automation

### A1. Cart abandonment is admin-triggered <a id="a1-manual-cart-abandonment"></a>

**Today.** `/admin/shop/abandoned-carts/send-due` is a manual button
(noted by the explore agent:
`artifacts/resupply-api/src/lib/cart-abandonment/send-cart-abandonment-email.ts`).
The job exists and the dispatcher works; only the trigger is human.

**Smarter.** Schedule via `pg-boss` alongside the existing reminder
worker (`artifacts/resupply-api/src/worker/index.ts`). Cron:
hourly scan of `shop_carts` where `updated_at < now() - 24h`
AND `abandonment_email_sent_at IS NULL` AND
`communication_preferences.emailMarketing = true`. One email per cart
forever (already enforced by `_sent_at` flag). Time-tiered copy
(24 h / 72 h / 7 d) is a nice next step but not required for
auto-send.

### A2. Insurance estimate doesn't learn <a id="a2-static-estimate"></a>

**Today.** `/shop/insurance-estimates` looks up a static
`PAYER_ESTIMATES` table (`artifacts/cpap-fitter/src/lib/insurance-estimate-data.ts`)
hand-maintained by billing. The actual claim outcomes in
`resupply.claims` (success/denial/paid amounts) never feed back.

**Smarter.** Quarterly job: for each `(payer, sku)` pair, compute
P50/P90 patient OOP from the prior 90 days of `paid_amount -
patient_paid_amount` rows. Surface as a "based on N recent orders"
addendum on the estimate response. Doesn't replace the static
disclaimer — augments it with real data when the sample is large
enough (N ≥ 20 say).

### A3. Mask recommendations are open-loop <a id="a3-no-recommendation-feedback"></a>

**Today.** `recommendationEngine.ts` is a static weighted formula
(per the explore-agent summary). Returns / NPS / re-fit requests are
captured but never fed back into mask scoring.

**Smarter.** Two stages:
   (a) **Short-term, no ML:** introduce a `mask_outcome_signals` table
       written to on (i) return-with-fit-reason, (ii) NPS ≤ 6 with
       fit-related verbatim, (iii) re-fit support ticket. A weekly job
       degrades the `brandMultiplier`/`fitScore` of any (mask, size,
       measurement-bucket) cell where outcome signal density exceeds
       a threshold (e.g. >15 % return-for-fit at N ≥ 30).
   (b) **Long-term:** the same table is the training set for a real
       collaborative-filtering layer later.
Critical: this is a recommendation-quality lever, not a personalization
play — same patient gets the same answer; the population of patients
who came before them shapes it.

### A4. Returns queue treats every RMA as manual review <a id="a4-rma-rules"></a>

**Today.** `/admin/shop/returns` (per explore agent) is a per-return
workbench: every requested return waits for staff approve/deny.

**Smarter.** Rule layer in front of the queue:
   - **Auto-approve:** reason = `defective` AND age < 7 d AND order
     value < $X cap → status jumps to `approved`, RMA email fires.
   - **Auto-offer-replacement-only:** age 7–30 d, sealed packaging
     attested → "replacement only, no refund" auto-offer.
   - **Manual escalation:** everything else — high-dollar, repeat
     returner, age > 30 d, partially-used.
Cuts staff RMA volume substantially without exposing the company to
fraud since the auto-paths are bounded.

### A5. Reminder opt-out is split across SMS and email <a id="a5-opt-out-split"></a>

**Today.** Twilio's STOP handling globally opts out an SMS number, but
the hourly reminder scan checks `communication_preferences.emailMarketing`
for bulk campaigns *only* (per explore-agent summary of
`lib/resupply-reminders/`) — a patient who set `emailMarketing = false`
can still get scheduled prescription reminders unless they explicitly
opted out via the magic-link `/reminders/manage` page.

**Smarter.** One change to the reminder scan: respect
`emailMarketing = false` as a hard stop for email reminders too. If
the patient wants prescription reminders specifically, they re-enable
via `/reminders/manage`. Honors the simpler mental model
("unsubscribe means unsubscribe") that customers expect.

### A6. Pre-claim eligibility is not run at order time <a id="a6-eligibility-preflight"></a>

**Today.** Order intake validates schema and persists, then the claim
is filed and may be denied weeks later. Failure surfaces in the
billing-denials admin queue and creates a re-contact loop with the
customer.

**Smarter.** At order-submit (or in a 5-minute follow-up job), call a
270/271 eligibility check (the integration belongs in
`artifacts/resupply-api/src/integrations/eligibility/`). Two outcomes:
   - **Coverage confirmed:** annotate the order; nothing customer-visible
     changes.
   - **Coverage denied/missing:** raise an admin ticket *and* email the
     customer: "we need a bit more info — can you confirm your member
     ID or try a secondary plan?" *before* the order ships.
Catches misspelled member IDs and plan-change-of-year issues at minute
five instead of week three.

### A7. Order failed-email rows have no retry/triage <a id="a7-failed-email-rows"></a>

**Today.** `email_status = "failed"` rows in `public.orders` (per
explore-agent summary of `routes/storefront/orders.ts:49-120`) stay
in place but are only surfaced via an admin search. No retry, no
digest, no escalation.

**Smarter.** A daily 9 AM job that emails the on-call admin a digest
of the last 24 h of `email_status = "failed"` orders with one-click
"resend" deep links. The job also auto-retries SendGrid 5xx failures
with backoff (transient, not customer-data issues).

---

## Cross-cutting patterns

| Pattern | Where it bites | Fix sketch |
| --- | --- | --- |
| **Email re-entry across flows** | `/consent`, `/order`, `/insurance/estimate`, `/reminders` | Cookie-backed `fitter_identity` (P6). |
| **Two consent moments** | `/consent` + `/order.consentToContact` | One server-side consent record (P1). |
| **Skipped answers scored as `false`** | `/questionnaire` → recommendation engine | Explicit "not sure" + neutral weight (P4). |
| **Static lookup tables that should learn** | Insurance estimate, mask scoring | Quarterly batch backfills from real outcomes (A2, A3). |
| **Admin queues that should be auto-actioned in obvious cases** | RMAs, abandoned carts, failed-email rows | Pre-filter with rules; escalate only edge cases (A4, A1, A7). |
| **Token-emailed magic links for signed-in users** | `/reminders/manage` | Detect session; redirect in-app (P5). |
| **Long single-page surfaces** | `/account` (2,148 LOC), `/order` (1,011 LOC) | In-page navigation / tab routing (C1). |

---

## What this review deliberately leaves alone

- The on-device measurement pipeline (MediaPipe). It's already
  privacy-correct and the friction is mostly inherent to camera
  permission UX.
- The HIPAA/audit/logging invariants in `CLAUDE.md` — none of the
  recommendations above add image logging, order-body logging, or
  PHI in marketing pipelines.
- The Git/migration drift hooks — orthogonal to user-facing process.
- Admin permission model (`requirePermission` rollout) — already in
  flight per the polish plan.

---

## Suggested next step

Pick 2–3 items from the "Top-of-list" header above as a single polish
wave (P1 + P3 + P5 is a coherent "make the patient journey shorter"
PR; A1 + A4 + A7 is a coherent "make admin queues smarter" PR). Each
fits inside a single PR's diff budget; none require schema migrations.
