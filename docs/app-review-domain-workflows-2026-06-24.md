# Domain workflow & usability review — 2026-06-24

A **workflow / ease-of-use review of every product domain** at `main` =
`55d8308`. Unlike the engineering-health and whole-app audits
([`app-review-2026-06-12.md`](./app-review-2026-06-12.md) and the
`app-review-*` series), this one uses a **UX lens**: for each domain it
traces the actual user journey through the page code, then judges whether
the workflow is _logical, complete, and low-friction_ for a non-technical
operator (a DME/CPAP small-business owner, CSR, RT, or biller) — and for
the customer-facing half, a tired, often older, often phone-bound patient.

**Method.** Seven domains were reviewed in parallel, each grounded in the
React page components (`artifacts/cpap-fitter/src/pages/**`) and the
backing route handlers, with file:line citations. The seven:

1. Workspace (CSR daily-driver hub)
2. Patients & Clinical
3. Orders & Shop
4. Billing (revenue cycle)
5. Analytics & Reports
6. System / Settings / onboarding
7. Customer-facing (patient) storefront + mask fitter

**Scope caveats.** This is a _code-reading_ review, not a live
click-through with production data, so a few findings may already be
mitigated by runtime state. Findings were **not** exhaustively
cross-checked against the full prior-review corpus — the engineering
reviews use a different lens, so the systemic items below are largely net-new,
but a handful of point fixes may already be roadmapped. Treat severities as
UX-impact, not correctness.

---

## Executive summary

**The information architecture is genuinely good.** The six admin
nav-groups map cleanly to real jobs, the Billing nav is sequenced in
claim-lifecycle order, the Home dashboard and Billing Hub are real command
centers, and Control Center is a best-in-class feature-switch UI. The app
is not disorganized.

**The friction is concentrated in seven _repeating_ patterns, not a
hundred unique bugs.** The same handful of workflow defects recur across
nearly every domain — which is the good news: a small number of _systemic_
fixes, several of which can copy a pattern that **already exists elsewhere
in the same codebase**, would lift the whole product. The app frequently
contains the cure for its own disease (the billing **verify** page already
has the patient-search picker that a dozen other pages lack; the **Home**
dashboard and **Billing Hub** already deep-link metrics to the worklist
that fixes them, which the analytics dashboards never do).

### The seven cross-cutting patterns, ranked by leverage

| #     | Pattern                                                                                                | Where it recurs                                         | Fix already in-repo?                                                  |
| ----- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------- |
| **A** | **Raw UUID / slug / SKU hand-entry** where a search picker belongs                                     | All 6 admin domains                                     | ✅ `admin-billing-verify.tsx` patient search; `HcpcsCodeAutocomplete` |
| **B** | **Dead-end surfaces** — show info, offer no next action / no escalation                                | Workspace, Patients, Orders, Billing, Analytics         | ✅ Home tiles, Billing Hub, therapy-resupply all close their loop     |
| **C** | **Overlapping near-duplicate pages** with no "use this when…" guidance                                 | Workspace, Patients, Orders, Billing, Analytics, System | — (IA / copy work)                                                    |
| **D** | **Broken list→detail→action handoff** — no URL-addressable detail, no context carried, no return path  | Billing (worst), Patients, Workspace, Analytics         | partial (`?claim=` param exists but unread)                           |
| **E** | **First-run / empty states fail new tenants** — filter-empty ≠ day-one guidance; onboarding skippable  | System, Patients, Billing, Orders, Analytics, Customer  | ✅ server-driven `/admin/setup` checklist already exists              |
| **F** | **Jargon leaks to the wrong audience** — payer/clinical/infra terms to patients & non-technical owners | Customer, System                                        | — (copy work)                                                         |
| **G** | **Async/confirmation states strand users; billable actions under-confirmed**                           | Customer, System                                        | ✅ Control Center typed-confirm is the model                          |

If only the **top three** are done — **A** (one shared `<PatientSearchCombobox>`
replacing every UUID box), **D** for Billing (make a claim URL-addressable),
and **B** for the CSR (turn conversation-detail into a launchpad) — the
day-to-day experience of the three highest-volume operator roles (CSR, RT,
biller) improves materially for a modest, low-risk amount of work.

---

## Cross-cutting patterns in detail

### A — Raw IDs/slugs/SKUs where a picker belongs · _leverage: very high · effort: M_

The single most pervasive friction in the product. Non-technical staff are
repeatedly asked to **type or paste an opaque identifier no human knows**:

- **Workspace:** Cases can only be filled by pasting a raw conversation/order/fax
  UUID (`admin-cases.tsx:391`); Alert recipient is a typed patient UUID
  (`admin-alerts.tsx:361`); Bulk-campaign requires an exact template-key **slug**
  (`admin-bulk-campaigns.tsx:587`); coaching-note target is a pasted admin UUID
  (`conversation-detail.tsx:1453`).
- **Patients & Clinical:** Inbound-fax filing wants patient/provider/Rx UUIDs
  (`admin-inbound-faxes.tsx:663`); "New coaching plan" and clinical lookup demand
  a hand-typed patient UUID (`admin-coaching.tsx:107`, `admin-clinical.tsx:57`);
  provider e-sign captures a typed patient _name string_ with no chart link
  (`admin-provider-esign.tsx:266`); fitter-invite attach wants a chart UUID
  (`admin-fitter-invites.tsx`).
- **Orders & Shop:** Returns "Replace" requires pasting Stripe `prod_…`/`price_…`
  (`admin-shop-returns.tsx:563`); backorders & substitution rules free-type SKUs
  (`admin-backorders.tsx:269`).
- **Billing:** Manual-claim's first field is a free-text `patient uuid`
  (`admin-billing-manual-claim.tsx:96`) — the lone UUID box in a domain that
  otherwise has search.

**The fix already exists.** `admin-billing-verify.tsx:79-90` does a debounced
`listPatients({ search })` combobox; `HcpcsCodeAutocomplete` and
`StartVideoVisitModal`'s locked-patient pattern prove the components exist.

**Fix:** extract a shared `<PatientSearchCombobox>` (plus provider, product/SKU,
and template variants) and replace every UUID/slug/SKU text input with it.
One component, ~12 small swaps; unblocks workflows that are today effectively
unusable for the target user.

### B — Dead-end surfaces (no next action) · _leverage: very high · effort: M–L_

Surfaces that present information but give the user nowhere to go:

- **Workspace:** Conversation-detail — the CSR's main screen all day — cannot
  create a case, schedule a follow-up, or book an appointment (verified: zero
  escalation actions in `conversation-detail.tsx`). Completed follow-ups offer no
  reschedule/log-outcome (`admin-followups.tsx:345`).
- **Patients:** Every therapy board links to a bare `/admin/patients/{id}` with no
  alert reason and no deep-link to the intervention form
  (`admin-rt-overview.tsx:597`, `admin-therapy-fleet.tsx:1083`); mask-fit "Actioned"
  only flips a status flag (`admin-mask-fit-worklist.tsx`); "Mark contacted/resolved"
  writes no real outreach (`admin-therapy-fleet.tsx:1205`).
- **Orders:** The "Orders" detail page has zero actions
  (`pennpaps-order-detail.tsx:120`); Subscriptions is metrics-only with no
  pause/cancel/skip; there is **no paid-order workspace at all** (verified: no
  `/admin/shop/orders` route).
- **Billing:** Worklists always bounce to the patient chart; the biller never acts
  inside billing. ERA "N unmatched need manual link" isn't clickable
  (`admin-billing-era.tsx:183`).
- **Analytics:** The systemic case — margin, turnover, reorder-funnel, and
  channel-engagement dashboards all surface a problem with **no link to the fix**
  (`admin-analytics-margin.tsx:174`, `admin-inventory-turnover.tsx:164`,
  `admin-reorder-reminders.tsx:100`).

**The fix already exists.** Home's KPI tiles and worklist cards all deep-link
(`dashboard.tsx:115`), the Billing Hub drills every metric into its worklist
(`admin-billing-hub.tsx:235`), and therapy-resupply closes its own
select→draft→send loop (`admin-therapy-resupply.tsx:551`).

**Fix:** give every list row, detail page, and chart a primary next-action
(drill-through, escalate, or act-in-place). Start with conversation-detail and
the analytics drill-throughs.

### C — Overlapping near-duplicate pages · _leverage: high · effort: M_

Users repeatedly pay a "which page do I use?" tax:

- **Email Inbox vs Conversations** (the email channel already lives in
  Conversations) — `email-inbox.tsx`.
- **Three patient-send surfaces** (Bulk Campaigns / Alerts / Playbooks) with three
  audience mechanisms and two merge-token syntaxes.
- **Three non-adherence worklists** (Interventions / Clinical outreach / Coaching)
  distinguished only by hidden data source; **three therapy boards** (rt-overview ⊂
  therapy-fleet, plus therapy-compliance); **two provider-signature systems**; the
  **25-tab patient 360** with 4 document surfaces.
- **Two things called "Orders"** (fitter log vs paid orders); product edit split
  across two surfaces.
- **~16 analytics dashboards across 4 sections with no index**, a redundant
  revenue trio, and a **dead "CSR productivity" panel** one tab from the live
  "Team throughput" page (`admin-analytics.tsx:811`).
- **Five overlapping config surfaces** (Settings / Company info / Storefront
  branding / System Config / Control Center) whose differences are explained only
  in code comments.

**Fix:** merge true duplicates (Email Inbox → a Conversations view; rt-overview →
fleet summary; the two e-sign systems → one); where pages are genuinely distinct,
add a one-line "use this when…" subheader and standardize merge-token syntax;
group the 25-tab 360 into ~6 labeled clusters; add an Analytics overview/index.

### D — Broken list→detail→action handoff · _leverage: high · effort: M_

The worst case is **Billing**: the claim workbench tracks the open claim in
local `useState` and never reads the URL (verified: `admin-insurance-claims.tsx:124`),
so the 14 worklists link to **four different destinations**, none of which opens
the specific claim the biller picked. Manual-claim even navigates to
`/admin/patients/:id?claim=<id>` — a dead param on the wrong page
(`admin-billing-manual-claim.tsx:68`). The same shape recurs as
monitoring→patient links that carry no alert context (Patients), patient→calendar
re-search (Workspace), and non-clickable audit-trail / dashboard rows (Analytics).

**Fix:** make the claim (and similar entities) **URL-addressable** — have the
workbench parse `?claim=<id>` on mount and standardize every worklist to link
`/admin/patients/:id/insurance-claims?claim=<claimId>`. Carry context (alert
reason) in deep links; add a "← back to [queue]" affordance on landing surfaces.
One change repairs the billing handoff across the whole domain.

### E — First-run / empty states fail new tenants · _leverage: high · effort: S–M_

A brand-new tenant is the highest-stakes moment and gets the least guidance:

- Onboarding is **opt-in and silently skippable** — the dashboard's
  `SetupProgressCard` renders nothing on load-pending/error
  (`SetupProgressCard.tsx:24`) and auto-hides; a distracted owner can run on
  default branding, the shared phone number, and no payouts forever.
- Empty states are **filter-oriented, not first-run**: the patient roster says "No
  patients match this view — adjust filters" to a tenant that has zero patients
  (`patients.tsx:650`); the Billing Hub shows a wall of zeros; reorder-reminders
  has no empty state at all.
- `Company information` is a 10-required-field wall with a disabled Save and
  feedback only at the bottom — reads as broken on day one
  (`admin-billing-config-organization.tsx:341`).

**The fix already exists.** The server-driven `/admin/setup` checklist
(`admin-setup-checklist.tsx`, `tenant-setup.ts:79`) is genuinely good — live
status, deep links, warm copy. It just isn't _unmissable_.

**Fix:** redirect a never-configured tenant to `/admin/setup` after the
agreements gate; make `SetupProgressCard` render in loading/error states; branch
empty states on `total === 0` for first-run guidance vs filtered-empty; add
domain-level "getting started" cards (esp. Billing).

### F — Jargon leaks to the wrong audience · _leverage: high · effort: S–M_

- **Patients** meet payer/clinical jargon at the buying moment: "cash-pay"
  (`shop.tsx:583`), undefined "deductible/coinsurance/post-deductible"
  (`insurance-estimate.tsx:399`), "DME company" (`fitter-invite.tsx:48`),
  "claims/EOB/payer" on the billing page (`account-billing.tsx:726`).
- **Non-technical owners** meet infra jargon they can't act on — Operations &
  Integrations show "redeploy the service," dispatcher names, raw error codes; Bot
  Playground prints `Set ANTHROPIC_API_KEY…` (`admin-bot-playground.tsx:131`); and
  Company-info asks for "Organizational NPI (type-2) / Taxonomy / PTAN / Surety
  bond" with zero inline help.

**Fix:** de-jargon the customer money moments (e.g. "Pay now by card — no
prescription needed"); reframe/gate platform-ops pages or add a plain "we handle
this" signal; add field-level help/links for the required clinical-billing
identifiers.

### G — Async/confirmation states strand users; billable actions under-confirmed · _leverage: med–high · effort: S–M_

- **Customer:** Post-payment "Confirming…" polls ~4× then tells the user to refresh
  manually, with no "safe to close" reassurance — anxious patients re-pay or call
  (`shop-checkout-success.tsx:177`, `order-pay.tsx:355`). Expired vs.
  already-confirmed reminder links are conflated into one vague message with no
  recovery (`reminders-manage.tsx:159`). Payment-update hard-redirects to Stripe
  with no interstitial (`account.tsx:631`).
- **System:** Provisioning a billable phone/fax number is one click under soft grey
  "may incur a charge" text, no amount, no confirm dialog (`admin-phone-settings.tsx:210`).

**The fix already exists.** Control Center's typed high-risk confirmation +
dry-run diff (`admin-control-center.tsx:726`) is the model.

**Fix:** bounded polling + "safe to close, we'll email you" + a `/track-order`
fallback; disambiguate the three reminder-link states and add "text me a new
link"; a confirm dialog stating the cost before provisioning a number.

---

## Prioritized backlog (suggested first sprint)

| Rank | Item                                                                                                                      | Pattern · Domain     | Effort | Why now                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------ | ------------------------------------------------------------------------------------ |
| 1    | Extract `<PatientSearchCombobox>` (+ provider/SKU/template) and replace **every** UUID/slug/SKU input                     | A · all              | M      | Unblocks ~12 workflows that are unusable for non-technical staff; fix exists in-repo |
| 2    | Make a claim **URL-addressable** (`?claim=<id>`), fix manual-claim nav, standardize worklist links                        | D · Billing          | M      | One change repairs the list→claim handoff across 14 worklists                        |
| 3    | Turn **conversation-detail** into a launchpad — Open case / Schedule follow-up / Add to calendar                          | B · Workspace        | M      | Biggest single gap on the highest-traffic CSR screen                                 |
| 4    | **Add a Shop Orders list→detail** (status, line items, tracking/delivered/refund) and relabel the fitter "Orders"         | B · Orders           | M–L    | Closes the broken fulfillment loop; fixes the most damaging label mismatch           |
| 5    | Add **dashboard→worklist drill-through** on every analytics chart                                                         | B · Analytics        | M      | Converts dead charts into operating tools                                            |
| 6    | De-jargon customer money moments + **bounded payment polling** + reminder-link recovery                                   | F·G · Customer       | S–M    | Direct conversion/trust/revenue protection                                           |
| 7    | Make **onboarding unmissable** — redirect never-configured tenants to `/admin/setup`; fix `SetupProgressCard` silent-fail | E · System           | S      | Day-one experience; prevents running on defaults                                     |
| 8    | Collapse **settings sprawl** to one hub; merge Email-Inbox→Conversations; add "use this when…" subheaders                 | C · System+Workspace | M      | Removes the recurring "which page?" tax                                              |
| 9    | Group the **25-tab patient 360** into ~6 labeled clusters; merge duplicate doc/timeline tabs                              | C · Patients         | M      | Largest single cut to daily cognitive load                                           |
| 10   | Wire **monitoring→action**: carry alert reason, deep-link the intervention form, cross-link the two clinical nav groups   | B·D · Patients       | M      | Fixes the domain's biggest dead-end pattern                                          |

---

## Exemplars — patterns already done well (copy these)

These are the in-repo references the fixes above should imitate:

- **Home dashboard** — KPI tiles + worklist cards all deep-link; empty states say
  "all clear"; new tenants get a `FirstActionsCard` (`dashboard.tsx:67`).
- **Billing Hub** — every metric drills to the worklist that fixes it
  (`admin-billing-hub.tsx:235`).
- **Control Center** — optimistic toggles + rollback, typed high-risk confirmation,
  plan-preset dry-run diff, audit feed (`admin-control-center.tsx:74`). The model
  for safe, owner-facing config.
- **Reports** — date presets, per-format QuickBooks-edition labels, email-to-accountant
  (`admin-reports.tsx`).
- **Email-From settings** — live SendGrid domain-auth banner, correct "display name
  alone has no effect" warning (`admin-email-settings.tsx:113`).
- **ERA posting + Verify** — hash-dedupe, inline reconciliation summary, patient
  search + no-record "quick check" mode (`admin-billing-era.tsx`, `admin-billing-verify.tsx:76`).
- **Sign-&-pay panel** — clear Sent→Viewed→Signed→Paid lifecycle badges, link-copy
  fallback (`CsrOrderRequestsPanel.tsx`).
- **Referral reviewer** — accept-into-chart wires intake → patient → docs
  (`referral-reviews.tsx:865`).
- **therapy-resupply** — closes its own select→draft→send loop
  (`admin-therapy-resupply.tsx:551`).
- **Duplicates merge** — well-guarded destructive flow with conflict-aware copy
  (`admin-patients-duplicates.tsx:55`).
- **Fitter funnel** — best-in-class privacy reassurance + forgiving failure states
  (`consent.tsx:184`, `capture.tsx:253`, `measure.tsx:50`).
- **Server-driven `/admin/setup` checklist** — live completion, deep links, warm
  language (`admin-setup-checklist.tsx`, `tenant-setup.ts:79`).
- **Audit Trail** — real investigative filters (employee/patient/time/action),
  admin-gated (`admin-audit-trail.tsx:120`).
- **Goals** — pace-to-goal with run-rate projection (`admin-goals.tsx:215`).

---

# Per-domain reviews

The seven full reviews follow, each grounded in file:line citations.

---

## 1. Workspace domain (CSR daily-driver hub)

**Who & jobs:** CSRs live here all day; RTs/billers/owner pass through. Core
jobs: see "what the team owes right now," answer inbound SMS/MMS/email from one
inbox, ring up walk-in counter orders, book/track appointments and callbacks, and
send proactive outreach.

**Primary workflows traced**

1. _Start-of-day triage_ — Home (`dashboard.tsx:112`) → setup progress → 5 clickable
   KPI tiles (`:115`, each deep-links a pre-filtered queue) → `TodayWorklistSection`
   (8 cards, top-5 each, `admin-today.tsx:93`) → quick links. **Smooth** — the
   best-designed page in the domain.
2. _Answer an inbound thread_ — list (`conversations.tsx:74`) → detail
   (`conversation-detail.tsx:68`): timeline + reply composer (canned replies,
   Draft-with-AI, autosaved drafts) + SLA/assignment + triage + Patient360 sidebar.
   **Smooth within the thread**; broken at escalation (below).
3. _Walk-in counter order_ — Front Desk (`front-desk.tsx:917`): search-or-capture
   patient → cart → payment/fulfillment → pre-dispense checklist → place → handoff.
   A clean linear state machine. **Smooth**, with one ship-lane dead-end.
4. _Send a bulk campaign_ — `admin-bulk-campaigns.tsx`: resolve audience → preview →
   count-named confirm (`:678`). Logical arc, but requires typing a template-key
   **slug** (`:587`). **Has friction.**
5. _Book an appointment_ — calendar `EventEditor` (`admin-company-calendar.tsx:940`):
   patient never pre-linked, always a fresh typeahead. **Has friction.**

**Strengths:** Home is excellent (deep-links + "all clear" empties +
`FirstActionsCard`); conversation-detail is a strong workspace (AI-draft, canned
replies, per-conversation autosave, 360 sidebar); Front Desk is a well-modeled
linear flow; Playbooks has the one real patient picker; loading/error states are
consistent; nav badges and the open inbox poll on a matching 60s cadence.

**Findings**

- **[High] Conversation detail has no "create case / follow-up / appointment"
  handoff** — `conversation-detail.tsx:340`. The TriagePanel offers only tags,
  snooze, claim; Patient360Panel has no escalation either. The CSR's highest-traffic
  screen is a read-and-reply island. _Fix:_ add Open-case / Schedule-follow-up /
  Add-to-calendar actions pre-linked to the patient/conversation.
- **[High] Cases can only be populated by hand-typing raw UUIDs** —
  `admin-cases.tsx:391`. The one page meant to unify channels is the hardest to
  fill. _Fix:_ search/picker + "Add to case" from conversations/orders/faxes.
- **[High] Email Inbox duplicates Conversations** — `email-inbox.tsx`; the email
  channel already lives in Conversations and rows route to the same detail. _Fix:_
  demote to a saved Conversations view.
- **[High] Bulk Campaigns "Template key" is an unguessable free-text slug** —
  `admin-bulk-campaigns.tsx:587`; the referenced template library is itself
  permission-gated away from the CSR who can start a campaign. _Fix:_ dropdown of
  existing templates.
- **[Med] Front Desk ship lane is a visible dead-end** — `front-desk.tsx:773`
  (selectable, then hard-blocked). _Fix:_ hide/disable with tooltip.
- **[Med] "Alert Library" send is a mislabeled real send requiring a raw Patient
  ID** — `admin-alerts.tsx:346`. _Fix:_ patient picker; relabel.
- **[Med] No pre-linked appointment from a patient/conversation** —
  `admin-company-calendar.tsx:953` (the locked-patient pattern exists in
  StartVideoVisitModal but isn't reused).
- **[Med] Scheduled video visits never appear on the Company Calendar** — two
  parallel schedules; double-booking risk.
- **[Med] Completed follow-up offers no next action** — `admin-followups.tsx:345`;
  also can't be created here (`:179` redirects to the patient page).
- **[Med] Three patient-send surfaces with no disambiguation** — `AppShell.tsx:264`
  (typed slug / UUID paste / real search + two token syntaxes).
- **[Low] Assignee shown as an 8-char ID hash, not a name** — `conversations.tsx:206`.
- **[Low] Episodes empty/first-run state is generic** — `episodes.tsx:457`.

**Top 3:** (1) Make conversation-detail a launchpad. (2) Replace every
raw-UUID/typed-slug field with a picker. (3) Collapse the overlapping
inbound/outbound surfaces (fold Email Inbox in; add "use this when…" to
Campaigns/Alerts/Playbooks).

---

## 2. Patients & Clinical domain

**Who & jobs:** CSRs live in Patients + Documents/e-sign; RTs own Therapy
monitoring + Clinical work. Core jobs: turn a faxed referral into a billable
record, get prescriptions/CMNs signed and filed, watch the base for
non-adherence, and act on what the boards surface. The patient-detail page is the
central hub.

**Primary workflows traced**

- _New referral → patient record_ — upload (`patients.tsx:538` / `referral-reviews.tsx`)
  → AI extract → verify insurance → accept creates patient + files docs + deep-links
  to chart (`referral-reviews.tsx:865`). **Smooth** — best-connected flow. Manual
  alternative has minor friction (raw E.164 phone, "customer" vs "patient" naming).
- _Paperwork → signature → filed_ — draft (`admin-documents.tsx`) → packet
  (`patient-packets.tsx`) → track (`admin-signature-tracking.tsx`) → file returned
  fax. **Has friction** — splits across two provider-signature systems + UUID fax
  filing.
- _Therapy alert → action_ — board surfaces a patient → bare `/admin/patients/{id}`
  → RT must separately find the Interventions worklist. **Broken-feeling** — no
  context carried; two disconnected nav groups.
- _Resupply due → order_ — `therapy-resupply.tsx:129` select → draft → approve & send
  (`:551`). **Smooth** — the one board that closes its loop.
- _Mask-fit report → follow-up_ — `mask-fit-worklist.tsx`: "Actioned" only flips a
  status string. **Broken-feeling dead-end.**
- _Duplicate cleanup_ — `admin-patients-duplicates.tsx`: group, pick survivor, merge.
  **Smooth.**

**Strengths:** patient-detail action surface is excellent (SMS/email/voice, verify
insurance, fitter invite, video visit, payment link, lifecycle with undo-close,
`PatientActionBar.tsx:448`); referral reviewer is the connective tissue;
duplicates merge is thoughtful; therapy-resupply and patient-packets close their
loops; Notes tab is optimistic with rollback; most boards have differentiated
empty/error states.

**Findings**

- **[High] 25 ungrouped tabs on the patient 360** — `patient-detail.tsx:296`, with
  near-duplicates (documents vs forms vs packets/signatures vs fax = 4 doc surfaces;
  timeline vs activity; episodes vs fulfillments vs resupply; Billing re-aggregating
  Insurance/PA/Claims that are also their own tabs). _Fix:_ ~6 labeled clusters +
  merge duplicates.
- **[High] Monitoring→action handoff carries no context** — `rt-overview.tsx:597`,
  `therapy-fleet.tsx:1083`, `therapy-compliance.tsx:221` all link to a bare patient
  page; the two nav groups never link to each other. _Fix:_ pass the alert reason;
  deep-link the intervention form.
- **[High] Mask-fit worklist is a triage dead-end** — `admin-mask-fit-worklist.tsx`;
  "Actioned" writes only a status string. _Fix:_ inline Log-intervention /
  Invite-to-fitter carrying the fit outcome.
- **[High] Two competing provider-signature systems** —
  `admin-signature-tracking.tsx:50` vs `admin-provider-esign.tsx:58`; the portal's
  "New request" captures only a typed patient _name string_. _Fix:_ consolidate;
  require a patient FK + attached document.
- **[High] Inbound-fax filing requires hand-copied UUIDs** —
  `admin-inbound-faxes.tsx:663`. _Fix:_ the patient/provider typeahead used elsewhere.
- **[High] Three near-duplicate non-adherence outreach surfaces** — Interventions
  vs Clinical-outreach vs Coaching (`AppShell.tsx:460`), distinguished only by hidden
  data source. _Fix:_ "use this when…" subheaders or merge into one worklist with a
  stage filter.
- **[High] Coaching & clinical lookup require pasting a raw patient UUID** —
  `admin-coaching.tsx:107`, `admin-clinical.tsx:57`. _Fix:_ patient typeahead.
- **[Med] Roster has no true first-run empty state** — `patients.tsx:650`
  (filter-oriented even at zero patients).
- **[Med] "Customer" vs "Patient" terminology split + raw E.164 input** —
  `patients.tsx:543`.
- **[Med] therapy-compliance is a read-only dead-end overlapping fleet** —
  `admin-therapy-compliance.tsx:137`. _Fix:_ make it a tab of fleet.
- **[Med] rt-overview is a strictly-weaker subset of therapy-fleet** —
  `admin-rt-overview.tsx:90`. _Fix:_ make it the lightweight landing that links into
  fleet.
- **[Med] "Mark contacted/resolved" records no real action** —
  `admin-therapy-fleet.tsx:1205`.
- **[Med] Inconsistent error/empty/loading idioms across tabs** — e.g.
  `ActivityTab.tsx:18` bare red `<p>` vs shared `ErrorPanel` elsewhere.
- **[Low] Providers registry has no edit/merge; referral-sources & education-videos
  are misfiled** — `admin-providers.tsx:131`, `AppShell.tsx:396`.

**Top 3:** (1) Wire monitoring→action (carry alert reason, deep-link the form,
cross-link the nav groups). (2) Group the 25-tab 360 + merge duplicates. (3) Kill
UUID hand-entry and consolidate provider e-sign.

---

## 3. Orders & Shop domain

**Who & jobs:** CSRs (build sign-&-pay orders, recover carts, work returns, qualify
leads), warehouse/fulfillment (labels, monthly count, backorders), owner (catalog,
pricing, subscription health). Central jobs: take/fulfill an order, ship it,
process a comfort-guarantee return, keep catalog/stock accurate, convert leads.

**Primary workflows traced**

- _Fulfill a paid shop order_ — **no order workspace.** A paid order surfaces only
  on `admin-shipping.tsx:138` ("Awaiting shipment"); "mark delivered" and "refund"
  exist server-side but are on no page. **Broken-feeling.**
- _Process a return/refund_ — `admin-shop-returns.tsx`: approve (`:442`) → received
  (`:508`) → refund (`:532`). **Smooth** until **Replace**, which demands typed
  Stripe IDs (`:563`).
- _Add/edit a product_ — `admin-shop-product-new.tsx`: one clean validated form.
  Edits split: copy on the edit page, price/stock only on the grid
  (`admin-shop-inventory.tsx:1291`). **Smooth**, minor split.
- _Monthly reconcile_ — `admin-shop-inventory-reconcile.tsx`: period → per-SKU counts
  → submit. **Smooth.**
- _Recover an abandoned cart_ — `admin-shop-abandoned-carts.tsx:172`: one "Send due
  reminders" button, email-only, no per-row. **Has friction.**
- _Take a counter/phone order_ — `CsrOrderRequestsPanel.tsx`: build line items, send
  sign-&-pay link, resend/cancel. **Smooth and well-designed.**

**Strengths:** the sign-&-pay panel is excellent (lifecycle badges, link fallback);
inventory grid has real operator empathy (optimistic saves, bulk stock bar, starter
catalog + genuine empty state); returns is a strict well-labeled state machine with
aging badges; shipping removes re-keying (merged address, weight presets, batch);
consistent helpful empty states.

**Findings**

- **[High] "Orders" nav points at the read-only fitter log, not the order you
  fulfill** — `pennpaps-orders.tsx` / `pennpaps-order-detail.tsx:120` (zero actions);
  nav hint says "fulfill, refund, look up" (`AppShell.tsx:544`). Deep label-vs-reality
  mismatch. _Fix:_ rename to "Fitter order requests"; add a real Shop Orders list.
- **[High] No Shop Orders list/detail page at all** — verified no `/admin/shop/orders`
  route; mark-delivered/tracking/refund endpoints exist but appear on no page. _Fix:_
  add Shop Orders list → detail with the actions the backend already supports.
- **[High] Returns "Replace" requires pasting raw Stripe product & price IDs** —
  `admin-shop-returns.tsx:563`. Non-technical staff will default to refunding
  (revenue loss). _Fix:_ catalog product/variant picker.
- **[Med] Fitter-invite "attach to chart" needs a hand-pasted patient UUID** —
  `admin-fitter-invites.tsx`. _Fix:_ patient search.
- **[Med] Returns & customer rows identify people by truncated IDs, not names/links**
  — `admin-shop-returns.tsx:377`, `admin-customer-detail.tsx:774`. _Fix:_ names +
  click-through.
- **[Med] Backorders & substitution rules are SKU-string typing with no picker** —
  `admin-backorders.tsx:269`; a typo silently creates a dead rule. _Fix:_ SKU
  autocomplete + existence validation.
- **[Med] Subscriptions is a metrics dashboard with no per-subscriber actions** —
  `admin-shop-subscriptions.tsx`; "pause/skip/change date" — a daily CSR request —
  can't be done here. _Fix:_ searchable subscriber list with lifecycle actions, or
  relabel "Subscription analytics."
- **[Med] Abandoned-cart recovery is a single all-or-nothing email button** —
  `admin-shop-abandoned-carts.tsx:172`. _Fix:_ per-row "Send now" + alternate channel.
- **[Med] Product edit split across two surfaces with no obvious bridge** —
  `admin-shop-product-edit.tsx` vs grid. _Fix:_ surface read-only price/stock with a
  link, or unify.
- **[Low] Shipping batch action requires typing a service code; no carrier picker** —
  `admin-shipping.tsx:232`.
- **[Low] Back-in-stock list is dispatch-only with no waitlist drill-down** —
  `admin-shop-back-in-stock.tsx`.
- **[Low] Inventory "preview mode" (no Stripe) looks editable but fails on save** —
  `admin-shop-inventory.tsx:1018`. _Fix:_ link the banner to the Stripe-connect step.

**Top 3:** (1) Add a real Shop Orders list→detail and relabel the fitter "Orders."
(2) Replace every raw-ID/SKU box with a catalog/patient picker (returns Replace
first). (3) Make returns/customer rows human-readable and clickable.

---

## 4. Billing domain (revenue cycle)

**Who & jobs:** billers and the owner — fluent in claims, not software. Queue-driven
day: clear morning worklists, post 835s, work A/R, chase paperwork. The nav splits
Dashboards / Worklists (claim-lifecycle order) / A/R / Tools — a deliberate, good IA.

**The claim lifecycle as a workflow.** The intended path is encoded in nav order and
reinforced by the Billing Hub (`admin-billing-hub.tsx:145`), a genuine command center
where every KPI deep-links into its worklist. **But** the app communicates sequence
only through nav ordering — there is no first-run "set up billing, then start here"
thread, and 14 worklist tabs are a lot to internalize cold.

**Primary workflows traced**

1. _Work the eligibility queue_ — `admin-billing-eligibility.tsx:86`: filters, summary
   pills, per-row "Open" → patient page. **Strong list; action one indirection away.**
2. _Post an ERA (835)_ — `admin-billing-era.tsx:54`: hash-dedupe, inline paid-total +
   matched/unmatched, history. **Excellent.** Gap: "N unmatched" isn't clickable.
3. _Appeal/resubmit a denial_ — `admin-billing-denials-worklist.tsx:57`: ranked by
   recoverable × win-prob; row → patient page. **Great prioritization; weak handoff.**
4. _Submit a manual claim_ — `admin-billing-manual-claim.tsx:38`: requires a raw typed
   **patient uuid** (`:96`), then navigates to a dead `?claim=` param on the patient
   page (`:68`). **The worst flow in the domain.**
5. _Onboard billing config_ — `admin-billing-config.tsx:30`: 9-card grid, honest but
   **no sequencing** — a non-expert can't tell what's mandatory before claims transmit.

**Strengths:** deliberate IA; the hub closes the loop; consistent worklist skeleton
(header, summary pills, filters, table, empty/loading/error+retry); real
prioritization (denials by $×win-prob, PA by SLA, timely-filing by days-left); ERA
and verify are best-in-class; PHI discipline doesn't hurt triage.

**Findings**

- **[High] Worklist→claim deep-links don't open the claim; four different
  destinations** — the workbench tracks the open claim in local `useState`
  (`admin-insurance-claims.tsx:124`) and never reads the URL; worklists link to
  `/admin/patients/:id`, `/…/insurance-claims`, and `/…?claim=<id>` — none auto-opens
  the claim. _Fix:_ parse `?claim=<id>` and set `openClaimId` on mount; standardize
  every worklist link.
- **[High] Manual-claim requires a hand-typed patient UUID** —
  `admin-billing-manual-claim.tsx:96` (the lone UUID box; verify already has search).
  _Fix:_ the existing patient autocomplete.
- **[High] Manual-claim's success navigation is broken** —
  `admin-billing-manual-claim.tsx:68` lands on the patient root with a dead `?claim=`;
  the promised "add lines + submit" continuation is missing. _Fix:_ navigate to the
  workbench and honor the param.
- **[Med] Billing config is an unguided wall for a non-expert** —
  `admin-billing-config.tsx:30`: nine equal cards, no order, no required-vs-optional,
  not linked from `/admin/setup`. _Fix:_ sequence + readiness badges + a setup step.
- **[Med] No billing first-run / empty-state** — a fresh tenant sees a hub of zeros
  with no "configure payers, then create your first claim." _Fix:_ detect
  unconfigured billing → 3-step getting-started card.
- **[Med] ERA "unmatched need manual link" is a dead end** — `admin-billing-era.tsx:183`.
  _Fix:_ link the count to a filtered manual-match view.
- **[Med] Two SLA windows can disagree** — `admin-billing-prior-auths.tsx:84` vs
  `admin-billing-eligibility-worklist.tsx:48` (local state; hub uses a third). _Fix:_
  one saved preference.
- **[Med] "Open" links are ambiguous and unlabeled** — same word, different
  destinations; no "back to queue." _Fix:_ honest labels + a back affordance.
- **[Med] Config "read-only, managed by engineering" surfaces are a self-service gap**
  — modifier rules / denial codes / claim templates (`admin-billing-config.tsx:64`).
  _Fix:_ make at least modifier rules + templates tenant-editable.
- **[Low] Capped rentals diverges from the worklist skeleton** —
  `admin-billing-capped-rentals.tsx`.
- **[Low] Hub buries claim creation under "Ready to bill"** — `admin-billing-hub.tsx:254`;
  no Worklists-nav entry for "fulfillments to bill."
- **[Low] Denials dashboard vs denials worklist naming collision** — `AppShell.tsx:687`
  vs `:826`.

**Top 3:** (1) Make a claim URL-addressable and open it on arrival. (2) Fix
manual-claim entry (patient autocomplete + correct nav). (3) Turn billing config
into guided, status-aware onboarding linked from `/admin/setup`.

---

## 5. Analytics & Reports domain

**Who & jobs:** owner/managers (and a finance person): export money data for the
accountant, answer "how's the business doing," set targets + get alerted, and run a
"who accessed this patient" lookup. Jobs are well-identified; the weakness is that
almost no dashboard lets the manager act on what it reveals.

**The insight→action loop (central).** The domain's biggest failing: the dashboards
are overwhelmingly **dead-end charts.** Margin flags a low-margin SKU with no link
to pricing (`admin-analytics-margin.tsx:174`); inventory-turnover shows slow movers +
a waitlist count with no reorder/notify link (`admin-inventory-turnover.tsx:164`);
reorder-reminders shows the funnel with no drill to stuck patients and no "send"
(`admin-reorder-reminders.tsx:100`); channel-engagement surfaces failed sends with no
link to delivery-failures (`admin-analytics-channel-engagement.tsx:203`). The
exceptions prove it's achievable: Clinical-Analytics "stuck episodes" drills to the
patient (`admin-analytics.tsx:520`); the Audit packet is a real generate→fax flow.

**Primary workflows traced**

1. _Export a month-end finance bundle_ — Reports → preset → "All financial data" →
   QuickBooks Desktop/Online or email-to-accountant (`admin-reports.tsx:95`).
   **Excellent.**
2. _Set & track a goal_ — `admin-goals.tsx:147` → pace bar with projection (`:243`).
   **Strong standalone, but disconnected** — dashboards never show the goal line.
3. _Get alerted when denials spike_ — the nav hint and empty-state suggest
   denials/churn (`admin-kpi-alerts.tsx:233`), but the only selectable metrics are 4
   revenue/order keys (`:33`). **Broken promise.**
4. _Check who accessed a patient_ — `admin-audit-trail.tsx:120`: filter by
   patient/employee/date/action → table + CSV. **Genuinely usable.**

**Strengths:** the Reports page is the model the dashboards should follow; Audit
Trail is a real investigative tool; Goals pace-to-goal is the right mental model;
empty states are consistently good; the Audit packet is complete and well-guided.

**Findings**

- **[High] Dashboards dead-end with no path to action** — Financial + several
  Clinical pages (`admin-analytics-margin.tsx:174`, `admin-inventory-turnover.tsx:164`,
  `admin-reorder-reminders.tsx:100`, `admin-analytics-channel-engagement.tsx:203`).
  _Fix:_ row-level drill links to the matching worklist.
- **[High] KPI alerts promise denials/churn but can't create them** —
  `admin-kpi-alerts.tsx:33`. _Fix:_ add the metric keys, or correct the copy.
- **[High] Analytics sprawl: ~16 dashboards across 4 sections, no index** —
  `AppShell.tsx:930`. _Fix:_ an Analytics-home overview with links into the deep
  dashboards.
- **[Med] Redundant revenue/economics pages** — margin / revenue-by-source / ltv-cac
  slice the same data. _Fix:_ one "Unit economics" page with a toggle.
- **[Med] Dead "CSR productivity" panel duplicates a live page** —
  `admin-analytics.tsx:811` (permanently degraded, one tab from the working Team
  throughput). _Fix:_ remove the dead panel.
- **[Med] Goals and the dashboards that measure them are disconnected** —
  `admin-goals.tsx:28`. _Fix:_ overlay the target on the chart; "Set target" link.
- **[Med] No scheduled/recurring reports** — `admin-reports.tsx` (saved presets store a
  recipient but nothing auto-sends). _Fix:_ "email this preset monthly."
- **[Med] Reports max 90 days blocks annual/quarterly views** — `admin-reports.tsx:38`.
- **[Med] Audit Trail patient & record columns aren't clickable** —
  `admin-audit-trail.tsx:273`.
- **[Low] Reorder-reminders has no empty state** — `admin-reorder-reminders.tsx:100`.
- **[Low] LTV/CAC and Therapy report lack a date window** — inconsistent controls.
- **[Low] "Compare to prior period" applies to one report but lives page-level** —
  `admin-reports.tsx:150`.

**Top 3:** (1) Close the insight→action loop (drill-through everywhere). (2) Add an
Analytics overview + consolidate the redundant revenue pages. (3) Fix the
KPI-alerts ↔ Goals ↔ dashboards triangle.

---

## 6. System / Settings / onboarding domain

**Who & jobs:** a non-technical owner (super-admin) standing up and running their
tenant: get from sign-up to a working, self-branded workspace (brand, domain,
phone/SMS/fax, email sender, payments, catalog, team), flip features, keep messaging
healthy, get help. Highest-stakes domain for ease-of-use because it's first-run.

**First-run onboarding (central).** A new owner is **not** dropped on an empty
console, but **not** forced through onboarding either — the index lands on the
dashboard (`console.tsx:873`); the only hard gate is the legal `AgreementsGate`.
Guidance is a **soft, self-elected nudge**: `SetupProgressCard` (`dashboard.tsx:170`)
renders only while setup is incomplete, auto-hides, and **fails silent on
pending/error** (`SetupProgressCard.tsx:25`). The real spine is `/admin/setup`
(`admin-setup-checklist.tsx`, server-computed `tenant-setup.ts:79`) — genuinely good,
but opt-in. **Verdict: lightly guided, one step short of a true first-run wizard.**

**Primary workflows traced**

1. _Complete first-run setup_ — dashboard nudge → `/admin/setup` → grouped checklist
   with live status + deep links. **Strong**, but required-vs-recommended is
   debatable and three targets live outside the Settings nav.
2. _Set up email-From + domain auth_ — `admin-email-settings.tsx`: live SendGrid
   domain-auth banner (`:205`), correct warnings, dirty-gated save. **Excellent** —
   only gap is no link to _where_ to authenticate.
3. _Add a team member_ — `admin-team.tsx`: invite + role + optional password. **Complete**,
   but role vocabulary is tri-named.
4. _Turn on a feature_ — `admin-control-center.tsx`: optimistic toggles, typed
   high-risk confirm (`:726`), plan-preset dry-run diff. **Excellent — the standout.**
5. _Configure phone/SMS_ — `admin-phone-settings.tsx`: provision or BYO E.164. **Good**,
   but billable provisioning is one click under soft warning (`:210`).

**Strengths:** Control Center is a model feature-switch UI; the server-driven tenant
checklist computes real completion and is fail-soft; near-universal high-quality
state handling; Email-From and Storefront-branding are self-explanatory with live
status; System Configuration draws the tenant-vs-platform line clearly; the Support
loop is coherent.

**Findings**

- **[High] No forced first-run path, and the only nudge fails silent** —
  `SetupProgressCard.tsx:24`, `dashboard.tsx:170`. _Fix:_ redirect a never-configured
  tenant to `/admin/setup`; render the card in loading/error states.
- **[High] Settings sprawl: five overlapping "config" surfaces with no map** —
  `AppShell.tsx:1200` (Settings / Company info / Storefront branding / System Config /
  Control Center); "Settings" holds only a demo toggle (`admin-settings.tsx:102`).
  _Fix:_ make the checklist the canonical hub; rename/merge "Settings."
- **[High] "Company information" is a two-named, jargon-heavy, dead-on-arrival form**
  — `admin-billing-config-organization.tsx:295`: ~9 sections, 10 required fields, Save
  disabled with bottom-only feedback, identifiers (NPI/taxonomy/PTAN/surety) with no
  help; reachable at two URLs. _Fix:_ first-run framing, inline required-field flags,
  field-level help, one canonical URL.
- **[Med] Owner-facing nav surfaces platform-ops pages they can't act on** —
  `admin-operations.tsx`, `admin-integrations.tsx` (deploy/infra jargon, raw error
  codes). _Fix:_ gate behind a higher role or label "platform/advanced."
- **[Med] Automation rules are developer-grade** — `rules.tsx`, `admin-compliance-rules.tsx`
  (SKU prefix, payer match, integer priority, resolution order only in a code
  comment). _Fix:_ surface the order + a plain "what this rule does" preview.
- **[Med] Bot Playground promises prompt-tuning the owner can't do** —
  `admin-bot-playground.tsx:262` (says "tune," then "edit code"); prints raw env-var
  names. _Fix:_ reframe as "rehearse/preview"; plain offline copy.
- **[Med] Billable provisioning is one click with only soft warnings** —
  `admin-phone-settings.tsx:210`, `admin-fax-settings.tsx:166`. _Fix:_ a confirm dialog
  stating the cost.
- **[Med] Two look-alike checklists for two audiences** — `account-setup.tsx` (platform
  deployment, CLI) vs `admin-setup-checklist.tsx` (tenant). _Fix:_ hide account-setup
  from owners.
- **[Low] Team role vocabulary is tri-named** — `admin-team.tsx:58`.
- **[Low] Help & Resources is a near-empty hub** — `admin-resources.tsx:18` (one PDF).
- **[Low] Email-From & Slack setup name external steps with no link** —
  `admin-email-settings.tsx:155`.
- **[Low] System Config mixes "applies live" vs "applies on next deploy"** —
  `admin-system-configuration.tsx:344` (owner can't trigger a restart).

**Top 3:** (1) Make onboarding unmissable (redirect + fix silent-fail). (2) Collapse
settings sprawl into one mapped hub. (3) Separate owner-actionable config from
platform/advanced ops; link or de-jargon every named prerequisite.

---

## 7. Customer-facing (patient) experience

**Who & jobs:** CPAP patients — often older, tired, low-tech, mostly on phones: get
an AI-recommended mask that fits, buy supplies fast (cash or insurance), confirm a
resupply reorder from an SMS link in seconds, and self-serve their account without
phoning.

**Primary journeys traced**

- _(a) Mask-fitter funnel_ — `/fitter-invite` (`fitter-invite.tsx:105`) → `/consent`
  (`consent.tsx:464`) → `/capture` (`capture.tsx:182`) → `/measure` (`measure.tsx:114`,
  on-device MediaPipe) → `/questionnaire` → `/results` (`results.tsx:527`) → `/order`.
  **Mostly smooth and unusually well-guarded;** friction is the invite-gate confusion
  - funnel length.
- _(b) Shop → checkout_ — `/shop` (`shop.tsx:417`) → product → cart (`shop-cart.tsx:618`)
  → Stripe → success (`shop-checkout-success.tsx:177`). **Has friction** — "cash-pay"
  jargon, insurance buried, post-payment polling can strand.
- _(c) Resupply/reorder_ — SMS/email link → `/reminders-manage` (`reminders-manage.tsx:159`)
  or `/order-pay` (`order-pay.tsx:160`) → confirm/pay. **Has friction / drop-out risk**
  — ambiguous expired-vs-confirmed, no link recovery.
- _(d) Account self-service_ — `/account` (`account.tsx:456`), `/account/billing`
  (`account-billing.tsx:273`). **Broken-feeling at the edges** — empty states don't
  guide, payment-update hard-redirects, billing jargon.

**Strengths:** privacy reassurance is genuinely excellent and repeated where it
matters (`consent.tsx:184`, `capture.tsx:286`) — best-in-class for an anxious cohort;
the fitter is forgiving of failure (camera-denied recovery, extraction-failure hints,
optional retake, no-match next step); consent avoids dark patterns; order-success
rehydrates from `?ref+?email`; storage-blocked heads-up prevents silent data loss.

**Findings**

- **[High] "Cash-pay" is unexplained jargon at the buying moment** — `shop.tsx:583`,
  `results.tsx:148`. _Fix:_ "Pay now by card" + "No prescription needed — ships
  directly. Insurance claims take longer."
- **[High] Post-payment confirmation can strand the patient on "Confirming…"** —
  `shop-checkout-success.tsx:177`, `order-pay.tsx:355` (no ETA, no "safe to close," no
  fallback). _Fix:_ "still processing — safe to close, we'll email your receipt" +
  `/track-order` link.
- **[High] Expired vs. already-confirmed reminder link is ambiguous** —
  `reminders-manage.tsx:159` (one vague message conflates three states). _Fix:_
  distinguish them; offer "text me a new link."
- **[High] Insurance pathway is visually subordinate in the cart** — `shop-cart.tsx:1233`
  (footer link) vs the dominant card-checkout button. _Fix:_ a co-equal "Or use
  insurance — $0 with prescription" in the sidebar.
- **[High] Deductible/coinsurance/"post-deductible" unexplained in the estimate** —
  `insurance-estimate.tsx:50,399`. _Fix:_ inline definitions + state the assumption.
- **[Med] Update-payment hard-redirects out of the SPA with no signal** —
  `account.tsx:631`. _Fix:_ "Opening secure billing…" interstitial.
- **[Med] Account/orders empty states don't guide the next step** — `shop-orders.tsx`,
  account orders tab. _Fix:_ "Browse supplies" / "Add a card" CTA.
- **[Med] Billing page leaks payer jargon** — `account-billing.tsx:726` ("claims," "EOB,"
  "payer"). _Fix:_ "Insurance charges & what you owe" + tooltips.
- **[Med] "DME company/supplier" leaks into patient copy** — `fitter-invite.tsx:48`,
  `home.tsx:76`. _Fix:_ lead with "your CPAP supplier."
- **[Med] Resupply "nothing ships until you confirm" reads as contradictory** —
  `help-resupply-reminders.tsx:74`. _Fix:_ an explicit 3-step "remind → tap YES → ship
  & bill."
- **[Med] Out-of-stock isn't re-validated before Stripe checkout** — `shop-cart.tsx:499`.
  _Fix:_ pre-flight validate-cart with a "we adjusted your cart" toast.
- **[Med] Phone-ordering option is hard to find** — `help.tsx:145` (buried). _Fix:_ a
  persistent "Prefer to call?" header entry.
- **[Low] The fitter funnel is long, and the home CTA can feel like a dead-end** —
  `home.tsx:86` ("Get fitted") routes uninvited visitors toward an invite wall. _Fix:_
  relabel "Have an invite? Start your mask fitting," or lead walk-ups to `/masks`.

**Top 3:** (1) De-jargon the money moments (cash-pay, deductible, co-equal insurance).
(2) Make every "Confirming…"/polling state safe and bounded. (3) Disambiguate the
reminder-link states and add link recovery (the core recurring-revenue, most
phone-bound moment).

---

## Closing note

The recurring theme is encouraging: **this product mostly needs propagation, not
invention.** The best surfaces (Home, Billing Hub, Control Center, the setup
checklist, the verify-page picker, the fitter's privacy/recovery handling) already
demonstrate the patterns that the weaker surfaces lack. The highest-leverage program
is to **extract those patterns into shared components and apply them everywhere** —
a `<PatientSearchCombobox>`, a URL-addressable detail convention, a "primary
next-action on every row/chart" rule, a "first-run vs filtered-empty" empty-state
convention, and a plain-language pass on the customer money moments — rather than to
build new features.
