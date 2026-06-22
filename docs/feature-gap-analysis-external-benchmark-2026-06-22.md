# Feature & Function Gap Analysis — External Market Benchmark (2026-06-22)

**Audience:** CareMetric Breathe ownership + engineering.
**Question asked:** _"Thorough review of all functions and features; determine
functional/feature gaps that would enhance the app. Don't rely on the internal
report — research similar software, then compare."_
**Method:** (1) Code-verified inventory of the admin console, the patient
storefront/portal, the billing/RCM + EDI stack, the integrations layer, and the
~72 worker jobs. (2) **Independent external research** of competing and adjacent
software — Brightree (+ SNAP / ReSupply), WellSky **S3 Resupply** / Bonafide,
**NikoHealth**, **ResMed myAir / ReSupply**, **Parachute Health** (ePrescribe
network), **Curasev** (DME patient portal), and general DME RCM/clearinghouse
practice (Availity, Waystar). (3) Gap candidates verified against the codebase
before listing.

> This is deliberately **independent** of the existing internal reviews
> (`dme-owner-feature-gap-review-2026-06-21.md` and the 06-14/06-18/06-20 docs).
> Where they focus on _activating built-but-dormant levers_, this doc benchmarks
> against **what competitors and adjacent products ship that we do not** — i.e.
> genuinely new surface area, ranked by leverage.

---

## Headline

By any DME-resupply benchmark, **CareMetric Breathe is already more complete
than every named competitor on a feature-count basis.** It ships, in code,
things the incumbents sell as premium modules: on-device AI mask fitter,
three-vendor AI voice/SMS/email stack, full 837P/270-271/276-277/835 EDI, Da
Vinci PAS prior auth, AI claim scrubbing + denial analysis, capped-rental
modifier rotation, patient autopay + payment plans, omnichannel inbox, therapy-
cloud ingestion (ResMed/Philips/3B), and a D2C storefront with subscriptions.

So the real gaps are **not** "add more billing features." They cluster in four
places where the market has moved and we have a structural hole:

1. **Referral acquisition** — we ingest faxes; competitors plug into a
   provider-facing **e-prescribe network + EHRs**. This is the single biggest
   growth ceiling.
2. **Patient experience parity** — competitors ship **native mobile apps,
   live shipment tracking, self-scheduling, and Spanish**. We are web-only,
   English-only, with partial tracking and staff-only scheduling.
3. **Last-mile / local-delivery operations** — we have POD photos but **no
   driver app / route optimization** for DMEs that deliver locally.
4. **Back-office connective tissue** — **vendor/distributor restock EDI,
   two-way accounting sync, patient AR collections, and Medicare ADR/audit-
   response** workflows are thin or absent.

The detail and a ranked shortlist follow.

---

## Tier 1 — Strategic / growth gaps (highest leverage)

### 1.1 Provider-facing e-prescribe + EHR intake network ⭐ biggest gap

**What the market does:** Parachute Health turned DME referral intake into a
**network** — clinics/hospitals e-prescribe DME from inside Epic / Cerner /
PointClickCare, with AI fax-to-digital, bidirectional EHR write-back, and
referral-source status messaging. Brightree and WellSky integrate the same way.
This is how modern DMEs _acquire_ patients without growing CSR headcount.

**What we have:** Inbound fax triage + **AI referral extraction**
(`referral-review-extract`), a referral-source CRM/scorecard, and outbound
provider fax. That's the _receiving_ side of a fax workflow — good, but reactive.
We verified there is **no EHR/HL7/SMART-on-FHIR integration** anywhere except
Da Vinci PAS (prior auth only); migration `0295_drop_inbound_referral_subsystem`
shows an inbound-referral subsystem was actually _removed_.

**Gap:** No referring-provider ordering portal, no EHR connectivity (Epic/
Cerner/Athena/PointClickCare), no membership in an e-prescribe network.
**Why it matters:** Referral volume is the growth governor for any DME. Every
competitor is plugging into the provider's existing workflow; we ask the
provider to keep faxing.
**Recommendation:** Build a lightweight **provider portal** (token-gated, no
EHR project required to start) where a referring office can submit an order +
attach the sleep study + e-sign — mirroring our existing patient-packet e-sign
plumbing. Phase 2: SMART-on-FHIR / PointClickCare app-marketplace listing.

### 1.2 Native patient mobile app (iOS/Android) + push

**What the market does:** ResMed **myAir**, AdaptHealth **myAPP**, and most
resupply vendors ship native apps with **push notifications**, biometric login,
and app-store presence — the channel patients actually keep on their phone.
**What we have:** A polished React/Vite **web** SPA (PWA-ish) only. No native
app, no push; patient reminders are SMS/email/voice.
**Gap:** No app-store presence, no push channel, no "open app → reorder" tap.
**Recommendation:** Wrap the existing patient portal in a thin native shell
(Capacitor/Expo) to get push + store listing cheaply, _or_ at minimum ship a
true installable PWA with Web Push. Push is the cheapest incremental engagement
channel and the one channel we don't have.

### 1.3 Patient self-scheduling (fittings / setups / telehealth)

**What the market does:** Online self-booking for mask fittings, setups, and
telehealth, with automated reminders and no-show management.
**What we have (verified):** A **staff-side** company calendar + video-visit
scheduling, and video-visit reminders — but **no patient self-booking endpoint**
(grep for self-schedule/booking/available-slots returned nothing).
**Gap:** Patients can't pick their own fitting/telehealth slot; staff must
broker every appointment.
**Recommendation:** Expose a patient-facing slot picker over the existing
calendar (we already have the video-visit token + reminder infra to build on).

### 1.4 Spanish / multilingual patient surface

**What the market does:** Patient-facing DME tools commonly ship Spanish.
**What we have (verified):** **No i18n framework** — all patient copy is
hard-coded English (the only `lang`/locale hits are CPAP-domain strings, not
translations).
**Gap:** Entire patient experience is English-only.
**Recommendation:** Introduce an i18n layer (the AI stack can pre-translate the
storefront/email/SMS templates) and a Spanish locale — high ROI for adherence
and conversion in many DME markets, and a frequent RFP checkbox.

---

## Tier 2 — Revenue-cycle / billing gaps

Our RCM stack is genuinely strong; these are the specific holes vs. best-in-class.

### 2.1 Medicare ADR / audit-response (RAC / CERT / TPE) workflow

**Market:** DME-focused RCM tools manage **Additional Documentation Requests**
and audit responses (deadline tracking, document packaging, appeal letters) —
the highest-dollar back-office risk in DME.
**Us:** We have denial appeals + bill-hold + filing-deadline tracking, but
per CLAUDE.md the **compliance/audit machinery was deliberately retired**
(migration 0156). There is no ADR intake/response queue.
**Gap:** No structured response to payer documentation/audit requests.
**Recommendation:** A focused **ADR queue** (deadline, requested docs, packaged
response, outcome) — narrow, high-value, and consistent with "compliance handled
out of band" since it's operational, not a compliance attestation engine.

### 2.2 Vendor / distributor restock EDI (850 PO / 855 / 856 ASN)

**Market:** Inventory replenishment via distributor EDI / punch-out (auto-PO
when stock dips).
**Us (verified):** Rich _inbound_ inventory (reservations, reconciliation, low-
stock alerts, cycle counts) but **no purchase-order / distributor integration** —
restock is manual.
**Gap:** No automated supplier PO, no ASN ingest, no demand-based reorder point.
**Recommendation:** Add purchase-order objects + a distributor adapter (even
CSV/email to start, mirroring the PacWare pattern) and a reorder-point trigger
off the low-stock job we already run.

### 2.3 Two-way accounting sync

**Market:** Live QuickBooks Online / NetSuite sync.
**Us:** **Export-only** (QuickBooks IIF/QBO + CSV/PDF reports). No write-back,
no live ledger sync.
**Gap:** Finance re-keys or imports files; no real-time GL reconciliation.
**Recommendation:** QuickBooks Online API two-way sync (invoices, payments,
payouts) as the first connector.

### 2.4 Patient AR collections / dunning engine

**Market:** Structured dunning ladders + collections-agency handoff for patient
responsibility.
**Us (verified):** Patient statements (consent + quiet-hours aware), payment
plans, autopay — but **no escalating collections workflow** or agency export.
**Gap:** Patient AR that ages past statements has no automated next step.
**Recommendation:** A dunning cadence (statement → reminder → final notice →
agency export) reusing the playbook/escalation engine we already have.

### 2.5 Third-party patient financing

**Market:** CareCredit / Affirm-style financing at checkout for large out-of-
pocket DME.
**Us:** In-house payment plans + autopay only.
**Gap:** No external financing option to lift conversion on high-ticket items.
**Recommendation:** Optional CareCredit/Affirm at storefront checkout.

---

## Tier 3 — Patient-experience gaps

### 3.1 Live, branded shipment tracking

**Market:** "Order received → processing → driver en route → delivered" branded
tracking page; a top driver of reduced "where's my order?" calls.
**Us:** Order tracking exists with a carrier link "when available" and a
`carrier-tracking.ts` helper — but tracking is **partial / carrier-dependent**,
not a live branded status timeline fed by carrier webhooks.
**Recommendation:** Carrier webhook ingestion → branded status timeline +
proactive "shipped/out-for-delivery/delivered" notifications.

### 3.2 Reputation / review syndication

**Market:** Push post-delivery reviews to Google/Yelp; manage reputation.
**Us:** Robust **internal** reviews + Q&A + NPS + moderation — but reviews stay
on-platform.
**Recommendation:** Syndicate qualifying NPS promoters to Google review prompts.

### 3.3 Accessibility coverage for the admin console

**Us:** Storefront has axe a11y e2e tests; the **admin** console isn't covered.
**Recommendation:** Extend axe checks to admin surfaces (also an RFP checkbox).

---

## Tier 4 — Last-mile / fulfillment operations

### 4.1 Driver app + route optimization (local delivery)

**Market:** DMEs that deliver locally use driver mobile apps with route
optimization, on-truck signature/photo capture, and live ETA.
**Us (verified):** POD **photo** capture (`0111_shop_orders_pod_photo`,
`order-pod.ts`) and shipping labels (XPS) — but **no route optimization, no
driver app, no signature capture**; we're built for parcel ship-out, not local
delivery routes.
**Recommendation:** If any tenant delivers locally, a minimal driver PWA
(today's stops, navigate, capture POD/signature) is high-value; route
optimization can be a later phase.

### 4.2 Custom report builder / scheduled exports / warehouse feed

**Market:** Ad-hoc report builder + scheduled email exports + BI/warehouse feed.
**Us:** Many strong _canned_ analytics (LTV/CAC, payer profitability, fleet
KPIs) and CSV/PDF/QuickBooks exports — but **no self-serve report builder or
scheduled/warehouse export**.
**Recommendation:** A saved-query/report builder + scheduled CSV email, and an
optional warehouse/BI export for larger tenants.

---

## Tier 5 — Finish the half-built surfaces (low effort, real value)

These already exist in code but are partial — completing them beats net-new work:

- **Mask-fit feedback triage** — capture endpoint exists; close the loop to a
  CSR follow-up workflow.
- **Quarterly therapy summary PDF** — print view exists; finish patient
  download/persistence + "share with sleep MD."
- **Video-visit lifecycle** — WebRTC lobby/call works; wire scheduling +
  recall/no-show workflow (pairs with Tier 3.1 self-scheduling).
- **Form acknowledgements (NPP/AOB/ABN/financial)** — markup captured; confirm
  enforcement + CSR visibility end-to-end.
- **Referral conversion attribution** — invitations tracked; finish downstream
  conversion attribution.

---

## Ranked shortlist (leverage ÷ effort)

| #   | Gap                                                 | Tier | Leverage           | Rough effort |
| --- | --------------------------------------------------- | ---- | ------------------ | ------------ |
| 1   | Provider e-prescribe portal (phase 1, no EHR)       | 1.1  | Very high (growth) | Medium       |
| 2   | Patient self-scheduling on existing calendar        | 1.3  | High               | Low–Med      |
| 3   | Live branded shipment tracking + push/email         | 3.1  | High               | Medium       |
| 4   | Native app shell / Web Push                         | 1.2  | High               | Medium       |
| 5   | Spanish i18n for storefront + messaging             | 1.4  | High               | Medium       |
| 6   | Patient AR dunning ladder (reuse playbooks)         | 2.4  | High ($)           | Low–Med      |
| 7   | QuickBooks Online two-way sync                      | 2.3  | Med–High           | Medium       |
| 8   | Medicare ADR/audit-response queue                   | 2.1  | High ($, risk)     | Medium       |
| 9   | Vendor restock PO + reorder point                   | 2.2  | Medium             | Medium       |
| 10  | Finish Tier-5 half-built surfaces                   | 5    | Med (cheap)        | Low          |
| 11  | Driver app + POD signature (if local delivery)      | 4.1  | Tenant-dependent   | Med–High     |
| 12  | EHR / SMART-on-FHIR + e-prescribe network (phase 2) | 1.1  | Very high          | High         |

**If you do three things:** (1) the **provider e-prescribe portal** (unlocks
referral growth), (2) **patient self-scheduling + live tracking** (the two most
visible patient-experience gaps vs. competitors), and (3) **turn on the
dormant billing levers** the internal reviews already flagged (free denial-rate
reduction). Items 1–2 are net-new surface area; item 3 is activation.

---

## Sources (external research)

- DME software comparison — Brightree / WellSky / NikoHealth: synergyiq.net,
  spotsaas.com, nikohealth.com (Brightree/Bonafide alternative pages)
- CPAP resupply platforms — Brightree SNAP/ReSupply, WellSky **S3 Resupply**,
  ResMed **ReSupply**: brightree.com, wellsky.com, respiratory-therapy.com,
  sleepquest.com
- Patient portal / mobile app practice — Curasev, AdaptHealth **myAPP**,
  ResMed **myAir**: curasev.com, adapthealth.com/pages/myapp, resmed.com
- ePrescribe / referral network — **Parachute Health**:
  parachutehealth.com (eprescribe-intake, ai-intake, PAS launch)
- RCM denial prevention / eligibility (270/271), claim scrubbing: clustox.com,
  nikohealth.com, acuservecorp.com, os-healthcare.com
