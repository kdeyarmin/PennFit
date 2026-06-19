# CareMetric Breathe — marketing-site competitive analysis (June 2026)

Benchmark of the in-app **Breathe** platform marketing site (`/breathe/*`,
served on `cmbreathe.com`) against the leading DME/HME and adjacent
"AI-native healthcare ops" software websites, plus the concrete changes made
in response. Source pages live in
`artifacts/cpap-fitter/src/pages/breathe*.tsx` + `breathe.css`.

> **Brand note.** This is the **platform** marketing surface (CareMetric
> Breathe — the software we sell to DME/HME businesses), **not** the PennPaps
> patient storefront. See `CLAUDE.md` → "Brand architecture."

## What we benchmarked against

| Competitor                      | Positioning                                                                       | Primary CTA model                  |
| ------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| **Brightree** (ResMed)          | Incumbent HME/DME + pharmacy suite                                                | Sales-gated — "Schedule a meeting" |
| **Brightree Resupply** (+ SNAP) | CPAP resupply engine + live-call services                                         | Sales-gated — "Schedule a meeting" |
| **NikoHealth**                  | Modern cloud HME/DME platform                                                     | Sales-gated — "Request a Demo"     |
| **WellSky / Bonafide**          | DME/HME ERP (Bonafide now under WellSky)                                          | Sales-gated — "Request a demo"     |
| **Tennr**                       | AI-native referral/patient-flow automation (the design + AI-positioning standout) | Sales-gated — "Book a Demo"        |

### Per-competitor notes

- **Brightree** — Hero: _"Software solutions for HME and pharmacy
  providers."_ Leads with three product-category cards (Document Automation,
  HME/DME, Pharmacy). The **Resupply** page is the most relevant: it lists
  six patient-engagement modalities (IVR, guided calling, email, mobile app,
  online portal, scheduled order) and — crucially — attributes hard numbers
  to customers ("items per order **+42%**, revenue **+46%**", "average
  revenue per order **up ~50%**"). Sales-led throughout; no pricing, no
  self-serve.
- **NikoHealth** — The closest modern analog. Hero: _"HME | DME Software —
  Streamline Your Business Workflow."_ Heavy on **social proof** (customer
  logo carousel, "the most innovative organizations partner with NikoHealth",
  14+ named testimonials with titles) and a **stats dashboard** (76% faster
  fulfillment, 98% clean-claim rate, 40% more upfront collections). Segments
  by **equipment vertical** (CPAP, Respiratory, O&P, CGM, Incontinence,
  Mobility, Enteral, Resupply). Has a blog/resources surface and an FAQ.
  Leads with product UI imagery. Demo is form-gated.
- **WellSky/Bonafide** — One integrated DME/HME ERP; emphasizes order &
  delivery (mobile signature capture, offline), intake with real-time
  eligibility, a facility self-service ordering portal, document management,
  and resupply (native or via SnapWorx). AWS-hosted. Sales-gated.
- **Tennr** — Not DME, but the **design + AI-native benchmark**. Bold
  all-caps hero (_"RIGHT PATIENT. RIGHT CARE SETTING. EVERY TIME."_), an
  animated multi-step product pipeline, named testimonials **with
  headshots**, quantified **case studies** ("75% faster, 4X volume",
  "3-week backlog → same-day intake"), a **press logo wall** (Fortune,
  Forbes, Axios, Bloomberg), and HIPAA/SOC II badges. Clean, product-forward,
  motion-rich.

## What Breathe already does _better_ (keep / amplify)

1. **Self-serve live demo** — "Start the free demo" lands the visitor in the
   real console on sample data (`/admin?demo=1`), **no call, no credit card**.
   Every competitor above is sales-gated. This is our sharpest differentiator.
2. **Transparent pricing + an interactive ROI calculator** (`/breathe/pricing`,
   `/breathe/roi`). Brightree, NikoHealth, and Bonafide all hide pricing
   behind a sales call.
3. **Distinctive design** — an editorial "command-center" dark theme
   (Fraunces + Hanken, self-hosted) that reads nothing like legacy DME
   vendors. Already in Tennr's league on craft.
4. **AI-native story, told concretely** (`/breathe/compare` "Built AI-native,
   not bolted on"; the voice agent / copilot / claim-scrubber sections).
5. **Privacy as a feature** — on-device mask-fitting imagery, PHI kept out of
   logs (`/breathe/security`). A trust angle no competitor leads with.
6. **Strong objection-handling FAQ** — migration risk, data ownership,
   "does the AI replace my staff," device-cloud coverage.

## Gaps vs. competitors, and disposition

| #   | Gap                                                                                                             | Competitor doing it well                                                             | Disposition in this PR                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Home page never showed the product** — it led with an abstract animated "orb."                                | NikoHealth, Tennr lead with product UI.                                              | **Fixed.** Added a `LiveConsole` section under the hero with **real captured screenshots** of the live `/admin?demo=1` console — home dashboard, patient roster, omnichannel inbox, AI denials worklist, and orders.                                                                 |
| 2   | **Headline stats unattributed** — `7 / 38% / 22% / 9+ hrs` read as invented.                                    | Brightree ties numbers to named customers; NikoHealth labels a stats dashboard.      | **Fixed (honest framing).** Added a provenance note under the hero stat band ("modeled on typical DME economics + published industry benchmarks — directional, not a guarantee") linking to the ROI calculator. (The outcome cards lower on the page already cite industry sources.) |
| 3   | **No human contact path** — self-serve demo only.                                                               | All five offer "Book a demo / Talk to us."                                           | **Fixed.** Added a secondary "Book a demo / Talk to us" gate (Nav, hero, closing CTA) that captures a lead and surfaces phone + email — self-serve demo stays the primary CTA.                                                                                                       |
| 4   | **Marketing site was `noindex` even on `cmbreathe.com`** — invisible to search engines.                         | All competitors are indexed.                                                         | **Fixed.** `noindex` now applies everywhere _except_ the production apex; Railway preview + tenant hosts stay out of the index.                                                                                                                                                      |
| 5   | **No social proof** — one anonymous founder quote; no testimonials, logos, case studies, or review-site badges. | NikoHealth (14+ testimonials + logo wall); Tennr (headshots + case studies + press). | **Deferred — pre-launch.** We will NOT fabricate customers. See backlog below.                                                                                                                                                                                                       |
| 6   | **No vertical segmentation** — single CPAP/DME story.                                                           | NikoHealth segments by equipment type.                                               | **Partially addressed.** Added a business-profile "Who it's for" section to the home page (independent, multi-site, sleep/CPAP-focused, RCM-led); full per-vertical landing pages still deferred.                                                                                    |
| 7   | **No resources/blog** for SEO + thought leadership.                                                             | NikoHealth, Tennr.                                                                   | Deferred (content investment).                                                                                                                                                                                                                                                       |

## Changes shipped in this PR

- **Show the real product on the home page** — a new `LiveConsole` section on
  `/breathe` leads with a **~40-second product-tour video** of the live
  `/admin?demo=1` console (click-to-play, `preload="none"`, the home dashboard
  as its poster) and a gallery of **six real captured screenshots** —
  resupply opportunities, therapy fleet, AI denials worklist, omnichannel
  inbox, patient roster, and orders — each in a browser frame with a caption.
  Video + screens were recorded with Playwright against the demo sandbox;
  assets in `public/breathe/screens/`. (The illustrative `ProductShowcase`
  mockup still serves the deeper `/breathe/product` tour.)
- **Stat credibility** — provenance note under the hero stat band on both
  `/breathe` and `/breathe/features`, linking to the ROI methodology.
- **"Talk to us" path** — new `ContactGateModal` (+ `ContactEmailForm`,
  shared `useModalDismiss` hook) reusing the `/api/demo-lead` capture with a
  distinct `source`; secondary CTAs in the nav, hero, and closing CTA. No
  backend change.
- **SEO fix** — `isPlatformApexHost()` added to `lib/platform-host.ts`;
  `useNoIndex()` now indexes the apex and noindexes everywhere else. Unit
  tested.
- **"Who it's for" segmentation** — a business-profile self-qualification
  section on the home page (independent / multi-site / sleep-CPAP / RCM-led),
  reusing the exported `CapCard` + `.bx-caps` grid. Complements the role-based
  personas on `/breathe/why`; capability-based, no customer claims.

## Backlog — revisit once there are real customers

Do **not** fabricate any of these; add them when the underlying truth exists:

1. **Named testimonials** (ideally with headshots/titles) — the single
   biggest remaining gap vs. NikoHealth/Tennr.
2. **Customer logo wall** / "trusted by."
3. **Quantified case studies** ("X% faster," "Nx volume") from real pilots.
4. **Review-site badges** (G2 / Capterra) once listed and reviewed.
5. **Press / "as seen in"** wall once there's coverage.
6. **Resources/blog** for SEO + thought leadership.
7. **Vertical landing pages** (CPAP, respiratory, O&P, CGM…) à la NikoHealth.
8. **Refresh the captured screenshots** when the console UI changes (re-run the
   Playwright capture against `/admin?demo=1`).

Also shipped alongside the showcase: demo fixtures for the **Therapy Fleet**
and **Resupply Opportunities** pages (`demo/fixtures/therapy.ts` +
`demo/handlers/therapy.ts`). Those two routes previously **crashed** in the
self-serve demo (empty `{}` fallback → reading `summary.byCategory.mask` /
`summary.byKind.pressure_at_max` off undefined); they now render with sample
data, both in the live demo and in the home-page gallery.
