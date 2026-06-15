# CareMetric Breathe — Monetization Strategy & Pricing

**Date:** 2026-06-15
**Status:** Strategy / direction-setting (research + recommendations; no code)
**Audience:** Owner, partners, anyone deciding how this platform makes money.

> **Naming:** The platform/parent product is **CareMetric Breathe**
> (`PennFit` is the repo codename). **Penn Home Medical Supply** —
> storefront brand **"PennPaps"** — is **one tenant** on it. Earlier drafts
> of the multi-tenant docs used "CareMetric AI Resupply" for the leasable
> product; read those as the resupply module of **CareMetric Breathe**.

> This is a planning document. It does not change any running code. It
> pairs with [`multi-tenant-caremetric-strategy-2026-06-14.md`](./multi-tenant-caremetric-strategy-2026-06-14.md),
> which decided _that_ PennFit should be leased as a multi-tenant SaaS but
> deliberately deferred the pricing decision (its §6). This document fills
> that gap: it benchmarks the market and recommends concrete numbers for
> both the consumer business and the SaaS business.

---

## 1. TL;DR — the recommendation

PennFit has **two distinct businesses inside one codebase**, and they
should be monetized differently:

1. **B2C — Penn Home Medical Supply's own storefront.** Already live and
   already monetized (Stripe cash-pay shop + insurance billing). The lever
   here is **conversion and recurring revenue**, not a new price model: push
   Subscribe & Save adoption, add a paid concierge membership, and lift
   resupply order rate toward the industry's 45–50%.

2. **B2B SaaS — lease the whole platform to other DME companies as
   CareMetric Breathe.** This is the larger, higher-margin
   opportunity and the architecture is already pointed at it (organizations,
   per-tenant branding, custom domains, `tenant:onboard`). Recommended model
   is **per-active-patient-per-month (PAPPM) + a platform base fee + AI/usage
   add-ons + an optional payments revenue share** via Stripe Connect.

**Headline recommended SaaS pricing** (detail in §5):

| Tier           | Base platform fee | Per active patient / mo | Best for                                    |
| -------------- | ----------------- | ----------------------- | ------------------------------------------- |
| **Starter**    | $499/mo           | $1.25                   | Single-location DME, <1,000 active patients |
| **Growth**     | $1,500/mo         | $0.95                   | Regional DME, 1k–10k patients               |
| **Enterprise** | $4,000+/mo        | $0.65 (volume-tiered)   | Multi-site / >10k patients                  |
| **Dedicated**  | Custom (≥$8k/mo)  | Custom                  | Security-demanding whale (DB-per-tenant)    |

Plus metered add-ons (AI voice minutes, clearinghouse claims, SMS/voice
telecom passthrough) and a **0.5–1.0% Stripe Connect application fee** on
cash-pay volume processed through the platform.

---

## 2. What we're selling (capability recap)

A full capability inventory is out of scope here; the short version that
matters for pricing is that PennFit is **not** a point tool — it is a
near-complete operating system for a sleep/DME resupply business:

- **Patient acquisition & fitting** — privacy-first camera mask fitting
  (measurements only, no images leave the browser), storefront catalog,
  insurance-estimate tool, lead capture.
- **Resupply engine** — multi-channel reminders (SMS / email / push /
  **AI voice agent**), eligibility-aware reorder, Subscribe & Save,
  cart recovery, 80+ automation jobs.
- **Revenue-cycle / billing** — real-time eligibility (270/271), 837P
  claims, 835 remittance, denials, prior-auth, capped-rental tracking,
  payment plans, autopay — wired to the Office Ally clearinghouse and
  DaVinci PAS, with an **AI auto-submit queue** that reads Rx PDFs and
  populates HCPCS codes.
- **Clinical automation** — therapy-cloud data pulls (ResMed AirView,
  Philips Care Orchestrator, 3B React Health), compliance alerts,
  AI sleep coach, milestones, interventions, telehealth video visits.
- **AI layer (the differentiator)** — conversational voice agent,
  storefront + admin chatbots (PennPilot), email auto-reply, SMS intent
  classifier, post-call summarizer. Three HIPAA-eligible vendors wired
  with graceful fallback.
- **Admin console** — 150+ pages: Patient 360, conversations inbox,
  campaigns/playbooks, analytics (LTV/CAC, margin, payer profitability,
  CSR productivity), inventory, returns, documents/e-sign, team & RBAC.
- **Integrations** — PacWare (DME billing CSV exchange), therapy clouds,
  clearinghouse, fax (Telnyx), email (SendGrid), telecom (Twilio).

The strategic point: **most DME companies pay multiple vendors for slices
of this and still do resupply badly.** That is the wedge.

---

## 3. Competitive landscape & pricing benchmarks

### 3.1 Direct DME / resupply software competitors

| Vendor                    | What it is                                                           | Published / reported pricing                                                                                                   | Notes                                              |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **Brightree** (ResMed)    | Market-leading HME/DME platform + Brightree Resupply (+ SnapWorx)    | Reported ~**$250/mo for 1 user**, ~**$1,500/mo for 10 users**, **$5,000–$7,000/mo** at ~100 users; custom quotes, no free tier | Per-seat-ish, plus modules. Resupply is an add-on. |
| **WellSky / S3 Resupply** | SaaS resupply communication platform; optional live managed outreach | Custom quote (not public). Publishes outcomes: **45–50% order rates, $175+ AOV**                                               | Outcome marketing is the benchmark to beat.        |
| **Bonafide**              | DME/HME billing + management                                         | Custom quote; reported "around the same cost as Brightree"                                                                     | Billing-led.                                       |
| **NikoHealth**            | Modern HME/DME platform; positions as S3 alternative                 | "Transparent flat pricing," custom quote                                                                                       | Positions on simplicity + transparent pricing.     |

**Key takeaways for positioning:**

- Incumbents **don't publish prices** and sell per-seat + module bundles
  via sales reps. There is room to win on **transparent, outcome-aligned
  pricing** (per active patient, not per seat) — exactly what NikoHealth
  is starting to do.
- The **AI layer (voice agent, auto-submit, coaching) is not standard**
  in these products. That is PennFit's premium, defensible add-on.
- The published benchmark to anchor ROI conversations: **45–50% order
  rate, $175+ AOV** (S3/WellSky); one provider's live-call program lifted
  compliance from ~50% to 85% and **more than doubled** resupply revenue.

### 3.2 Adjacent: AI voice / receptionist pricing (for the AI add-on)

- AI voice agents in 2026 run **$0.10–$0.50/min** for managed all-in-one
  platforms (infra-layer is $0.05–0.15/min); healthcare-managed
  receptionist products bundle at **$199–$2,000/mo** depending on volume.
- This sets the ceiling for what we can charge for outbound AI voice
  resupply calls as a metered add-on, and the floor on what it would cost
  a DME to buy this capability separately.

### 3.3 DME unit economics (for ROI math)

- AdaptHealth: ~**$60/mo** on a 13-month Medicare CPAP rental; resupply
  orders **~$200**, **~3×/year**.
- So one well-run resupply patient is worth **~$600/yr in resupply orders
  alone**, before the initial setup/rental. A platform that costs the DME
  **~$1/patient/month ($12/yr)** to lift order rate from ~30% to ~50% pays
  for itself many times over — that is the entire sales pitch.

_Sources are listed at the end of this document._

---

## 4. Business model #1 — B2C (Penn Home Medical Supply storefront)

This business is already monetized. The work is optimization, not
reinvention.

### 4.1 Current state

- **Cash-pay shop** via Stripe (≈60 SKUs, masks $79–$199, cushions/
  tubing/filters $12–$45) — one-time + Subscribe & Save.
- **Insurance billing** via Office Ally (claim reimbursement net of COGS).
- React Health flagship line priced to undercut ResMed (Rio II $79 vs
  P10 $119) — a deliberate margin/value play.

### 4.2 Recommended moves (ranked by impact/effort)

1. **Make Subscribe & Save the default, not the option.** Recurring
   resupply is the single highest-LTV behavior. Recommend **10–15% off +
   free shipping** on auto-refill (the discount already exists as a
   promo concept). Target: shift a meaningful share of one-time buyers to
   subscriptions; each converted patient is worth ~$600/yr in resupply.

2. **Launch a paid "PennPaps Plus" concierge membership.** A consumer
   subscription **separate** from product subscriptions:
   - **~$9.99/mo or $79/yr.** Includes: free expedited shipping, priority
     human + AI support, the AI **sleep coach**, annual mask re-fit, early
     access to new masks, and a comfort-guarantee upgrade.
   - The AI sleep coach and fitting tech already exist — this monetizes
     them directly and creates a sticky, predictable revenue line that is
     independent of insurance reimbursement cycles.

3. **Push resupply order rate to the 45–50% benchmark.** The voice agent +
   escalation ladder (SMS → email → voice → CSR) is the mechanism. This is
   pure margin on an existing patient base.

4. **Bundle pricing.** Sell mask + cushion + filter "comfort kits" at a
   modest bundle discount to lift AOV toward the $175+ benchmark.

> **Guardrail:** none of this requires new column encryption, new audit
> machinery, or bypassing the single SendGrid From address — keep within
> the repo's hard rules.

---

## 5. Business model #2 — B2B SaaS (CareMetric Breathe)

This is the larger prize. The multi-tenant strategy doc already chose
**pooled multi-tenancy (org_id + RLS)** and a **loosely-coupled CareMetric
brand**. What follows is the commercial layer that sits on top.

### 5.1 Why per-active-patient, not per-seat

- DME value scales with **patients served**, not staff logged in.
- It aligns our revenue with the customer's revenue (they make ~$600/yr/
  resupply patient; we take a small slice).
- It avoids the incumbent's per-seat friction (customers ration logins).
- The strategy doc already mandates building **`org_id`-scoped usage
  metering into Phase 0** — so an active-patient meter is the natural unit.

Define **"active patient"** precisely (this is the billable meter): a
patient with a resupply-eligible therapy record **and** at least one
outbound touch or order in the trailing **90 days**. (Bill on a rolling
monthly count; this rewards us for engagement we actually drive and is
defensible to customers.)

### 5.2 Recommended tiers

|                             | **Starter**        | **Growth**           | **Enterprise**            | **Dedicated**                    |
| --------------------------- | ------------------ | -------------------- | ------------------------- | -------------------------------- |
| Base platform fee           | **$499/mo**        | **$1,500/mo**        | **$4,000+/mo**            | Custom, **≥$8,000/mo**           |
| Per active patient/mo       | **$1.25**          | **$0.95**            | **$0.65** (volume-tiered) | Custom                           |
| Target size                 | <1,000 active      | 1k–10k               | >10k / multi-site         | Whale needing physical isolation |
| Isolation                   | Pooled + RLS       | Pooled + RLS         | Pooled + RLS              | DB/project-per-tenant            |
| Storefront + fitting        | ✅                 | ✅                   | ✅                        | ✅                               |
| Resupply engine + reminders | ✅                 | ✅                   | ✅                        | ✅                               |
| Billing / clearinghouse     | ✅                 | ✅                   | ✅                        | ✅                               |
| Analytics suite             | Core               | Full                 | Full + custom reports     | Full + custom                    |
| AI add-ons                  | Metered            | Metered (discounted) | Included allotment        | Custom                           |
| Custom domain + branding    | Add-on             | ✅                   | ✅                        | ✅                               |
| Onboarding                  | Self-serve + guide | Guided               | White-glove               | White-glove                      |
| Support                     | Email              | Email + chat         | Priority + CSM            | Dedicated CSM                    |
| **Implementation fee**      | $1,500             | $5,000               | $10,000+                  | Custom                           |

**Worked example (Growth, 3,000 active patients):**
`$1,500 + 3,000 × $0.95 = $4,350/mo` (~$52k/yr) before add-ons. For a DME
whose 3,000 resupply patients represent **~$1.8M/yr** in resupply revenue
potential, that is **~3% of the revenue the platform is built to grow** —
an easy ROI story, and competitive with Brightree's ~$5–7k/mo enterprise
band while delivering the AI layer they don't have.

### 5.3 Metered add-ons (usage, billed on top)

Price these as **cost-plus passthrough with margin** so vendor price
changes never make a tier unprofitable:

| Add-on                                       | Suggested price                                              | Rationale                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **AI voice agent (outbound resupply calls)** | **$0.18–$0.25/min**                                          | Below the $0.10–0.50/min managed-market rate; well above our OpenAI/ElevenLabs/Deepgram cost. Bundle a free monthly allotment in Growth+. |
| **AI auto-submit claims**                    | **$0.50–$1.00 / claim** auto-coded, or include in Enterprise | This is direct labor replacement (a biller's time) — high willingness to pay.                                                             |
| **Clearinghouse claims**                     | Passthrough + **$0.10–$0.25/claim**                          | Office Ally costs are per-transaction.                                                                                                    |
| **SMS / MMS**                                | Twilio passthrough + ~20%                                    | Standard telecom markup.                                                                                                                  |
| **Email**                                    | Included up to a cap, then SendGrid passthrough              | Volume-gated.                                                                                                                             |
| **AI sleep coach / chatbot**                 | Per-active-patient uplift (~$0.25) or Growth+ inclusion      | Differentiator; can be a tier gate.                                                                                                       |
| **Dedicated instance**                       | Flat premium ($3–5k/mo)                                      | Covers the DB-per-tenant ops cost.                                                                                                        |

### 5.4 Payments revenue share (Stripe Connect)

Phase 2 of the multi-tenant plan moves each tenant onto **Stripe Connect**.
Take a **0.5–1.0% application fee** on cash-pay volume processed through
the platform. On a DME doing $1M/yr in cash-pay supplies that is
**$5k–$10k/yr of pure-margin revenue per tenant** with zero incremental
cost — and it scales automatically with the customer's success.

### 5.5 Packaging within the CareMetric suite

- Sell **Resupply-only, EMR-only, or bundled** (the strategy doc keeps the
  products loosely coupled precisely to allow this).
- **Bundle discount** (~15%) for taking both CareMetric EMR + Resupply —
  drives cross-sell into the existing EMR customer base, which is the
  cheapest acquisition channel available.

---

## 6. What gates the SaaS revenue (and shapes pricing)

These are commercial realities, lifted from the multi-tenant strategy doc's
§7 and made explicit because they affect **when** we can charge and **how
much**:

1. **You become a Business Associate to every tenant.** PennFit retired
   its in-app HIPAA machinery ("handled out of band by the owner") — that
   assumption breaks the moment we host other companies' PHI. **A BAA per
   tenant and, realistically, SOC 2** are needed to close mid-market and
   enterprise deals. SOC 2 is also a **pricing-power lever**: it justifies
   the Enterprise/Dedicated premium and is table stakes against Brightree.
2. **Build the active-patient meter in Phase 0.** Billing on a meter you
   bolt on later is painful and disputable. Metering is already a Phase 0
   requirement — keep it there.
3. **Stripe Connect (Phase 2) unlocks the payments rev-share** — sequence
   it early enough to capture that revenue line.
4. **Implementation fees are not just margin** — they fund the white-glove
   `org_id` backfill / data-migration effort each tenant onboarding
   requires, and they qualify serious buyers.

---

## 7. Phased monetization roadmap

| Phase   | B2C                                                      | B2B SaaS                                                                      | New revenue unlocked                  |
| ------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| **Now** | Make Subscribe & Save default; push order rate to 45–50% | —                                                                             | Higher LTV on existing patients       |
| **Q1**  | Launch "PennPaps Plus" membership ($9.99/mo)             | Land 1–2 **design-partner** DMEs at a discounted flat fee while Phase 0 ships | Consumer recurring + first SaaS logos |
| **Q2**  | Bundle kits; AOV lift                                    | Stand up tiered PAPPM pricing + metering; BAA template + SOC 2 kickoff        | SaaS MRR begins                       |
| **Q3**  | —                                                        | Stripe Connect rev-share; AI add-on metering live                             | Payments share + usage revenue        |
| **Q4+** | —                                                        | Enterprise/Dedicated tier; CareMetric EMR cross-sell bundle                   | Move upmarket; raise ACV              |

---

## 8. Illustrative revenue model (SaaS, conservative)

Assumptions: average tenant = Growth tier, 2,500 active patients, modest
add-on + payments usage.

- Platform + PAPPM: `$1,500 + 2,500 × $0.95 = $3,875/mo`
- AI voice + SMS add-ons: ~$600/mo
- Stripe Connect (0.75% of ~$60k/mo cash-pay): ~$450/mo
- **≈ $4,925/mo per tenant → ~$59k ARR/tenant**

| Tenants | Approx. ARR |
| ------- | ----------- |
| 5       | ~$295k      |
| 20      | ~$1.2M      |
| 50      | ~$3.0M      |

Even at 20 tenants this materially exceeds the value of the platform as a
single-company internal tool — which is the entire thesis of the CareMetric
direction.

---

## 9. Recommended next steps

1. **Decide the headline pricing** (this doc's §5 table) so Phase 0
   metering is built to the right billable unit.
2. **B2C quick wins now** — Subscribe & Save default + PennPaps Plus
   membership; neither needs the multi-tenant work and both compound LTV.
3. **Start the BAA template + SOC 2 scoping in parallel with Phase 0** —
   these gate _signing_ tenants regardless of code readiness, and they
   underwrite the premium tiers' pricing.
4. **Sign 1–2 design-partner DMEs** at a discounted flat fee to validate
   the per-active-patient meter and the ROI narrative before list pricing
   goes public.

---

## Sources

- Brightree DME/HME pricing (per-user tiers): https://www.itqlick.com/brightree-dme-hme/pricing
- Bonafide vs Brightree cost comparison: https://www.itqlick.com/compare/bonafide-billing-management/brightree-dme-hme
- WellSky / S3 Resupply (order rate & AOV benchmarks): https://wellsky.com/blog/what-makes-s3-resupply-the-best-dme-resupply-platform/ ; https://s3resupply.com/
- DME software comparison (Brightree vs WellSky vs NikoHealth): https://synergyiq.net/dme-software-comparison.html
- NikoHealth pricing posture: https://www.capterra.com/p/240262/NikoHealth/ ; https://nikohealth.com/s3-resupply-alternative/
- AI voice agent pricing 2026: https://www.retellai.com/blog/ai-voice-agent-pricing-full-cost-breakdown-platform-comparison-roi-analysis ; https://aircall.io/blog/best-practices/ai-voice-agent-cost/
- Medical answering / AI receptionist cost: https://voice.ai/hub/ai-voice-agents/medical-answering-service-cost/ ; https://www.getnextphone.com/blog/ai-receptionist-cost
- CPAP resupply revenue / DME economics (AdaptHealth): https://medtrade.com/news/respiratory-sleep/strategy-for-cpap-compliance-and-resupply/ ; https://acuservecorp.com/outsourcing-cpap-resupply/

## Related internal docs

- [`multi-tenant-caremetric-strategy-2026-06-14.md`](./multi-tenant-caremetric-strategy-2026-06-14.md) — the SaaS direction this pricing plugs into.
- [`multi-tenant-phase-0-engineering-plan-2026-06-14.md`](./multi-tenant-phase-0-engineering-plan-2026-06-14.md) — where the usage meter gets built.
- [`multi-tenant-cutover-playbook-2026-06-14.md`](./multi-tenant-cutover-playbook-2026-06-14.md) — the `org_id` rollout mechanics.
