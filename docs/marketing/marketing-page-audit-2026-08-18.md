# Marketing-site audit — what shipped, and what the site still said (Aug 2026)

Review of the customer-facing platform marketing surface (`/breathe/*`,
served on `cmbreathe.com`) against the features actually shipped since the
last marketing pass, plus the competitive response to **SleepGlad**.

> **Brand note.** This is the **platform** marketing surface — CareMetric
> Breathe, the software sold to DME/HME businesses — **not** the PennPaps
> patient storefront. See `CLAUDE.md` → "Brand architecture."

Companions:
[`breathe-competitive-analysis-2026-06.md`](./breathe-competitive-analysis-2026-06.md)
(the June benchmark against Brightree / NikoHealth / Bonafide / Tennr) and
[`../competitor-analysis-sleepglad-2026-08-18.md`](../competitor-analysis-sleepglad-2026-08-18.md)
(the fitter-level teardown this responds to).

---

## 1. The finding, in one line

**The marketing site was selling a convenience feature that had quietly
become a clinical instrument.**

Between the last marketing pass and today, migrations `0481`–`0496` and five
PRs (#1262, #1263, #1265, #1266, #1267) shipped the Mask Intelligence
Catalog, a six-tier fitting engine, versioned safety screening, formulary
scoping, confidence gating, a stamped clinical fit report, a provider
referral portal, an in-office QR entry point, a fitter-outcomes dashboard,
and an established-patient re-fit campaign.

Every single one of those was invisible to a buyer. The fitter appeared on
the site in exactly one register — _"patients fit themselves at home, no
staff time on fittings and no sample masks opened just to be thrown away"_ —
which is a **labour-saving** pitch. Meanwhile the actual competitive
argument against a point-solution fitter is a **clinical rigour** pitch, and
we were not making it anywhere.

That mattered commercially because the one competitor who attacks our core
differentiator head-on (SleepGlad, now the AI-fitting layer inside VGM Total
Sleep Services) markets exactly the labour-saving story — so on the axis the
site was competing on, we looked like a tie.

---

## 2. Gap register

| #   | Gap on the site                                                                                                                                  | Shipped in                               | Disposition                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | **No page for the fitter at all.** Every other pillar has a deep dive; the sharpest differentiator had a feature card.                           | 0481–0486                                | **Fixed** — new `/breathe/mask-fitting`, added to the deep-dive index (gold) and the footer.                  |
| 2   | **Safety framed as nothing.** The hard-filter design — the single strongest structural claim we own — appeared nowhere.                          | `lib/fitting/tiers.ts`                   | **Fixed** — the tier ladder is the centrepiece of the new page; a compare row and an FAQ answer carry it too. |
| 3   | **Magnetic-implant screening absent.** Including that it screens the _household_ and offers the magnet-free twin first.                          | 0484, 0492, 0493                         | **Fixed** — safeguards section + FAQ.                                                                         |
| 4   | **Sizing described as "the perfect size."** No millimetre bands, no fit diagram, no explanation of _why_ a size was chosen.                      | 0481, `components/fit-range-diagram.tsx` | **Fixed** — "Show your work" section; patient-experience card rewritten.                                      |
| 5   | **Formulary control unmentioned.** Contract/payer/location/therapy-mode scoping is a genuine enterprise differentiator.                          | 0482                                     | **Fixed** — "Show your work" section + FAQ.                                                                   |
| 6   | **Confidence gating unmentioned.** "The engine is allowed to say I don't know" is a trust argument nobody else makes.                            | `lib/fitting/confidence.ts`              | **Fixed** — safeguards section + FAQ.                                                                         |
| 7   | **Clinical fit report unmentioned.** The "what was ruled out and why" report is the one artifact a point tool has no equivalent for.             | 0483, 0491, 0495                         | **Fixed** — "Show your work" section + a new compare row.                                                     |
| 8   | **Provider referral portal had zero marketing surface.** A whole shipped subsystem.                                                              | 0487, `routes/provider/*`                | **Fixed** — section on the new page, home feature card, features-page bullets, a new compare row.             |
| 9   | **Only one way to start a fitting was described** (text a link). The counter and the existing roster were missing.                               | 0489, 0490                               | **Fixed** — "Three ways in" section; FAQ.                                                                     |
| 10  | **Fitter-outcomes analytics unmentioned.**                                                                                                       | `routes/admin/analytics-fitter-outcomes` | **Fixed** — "Measure it" section, and it carries the anti-accuracy-claim argument (see §4).                   |
| 11  | **SleepGlad absent from every comparison surface.** The compare table covered only DME suites, so a buyer shopping a point fitter found nothing. | —                                        | **Fixed** — head-to-head table on the new page + a `/breathe/switch/sleepglad` landing page.                  |
| 12  | **Module toggles unmentioned.** "Turn off the parts you don't use" is a real objection-handler for small operators.                              | 0488                                     | **Fixed** — features-page bullet.                                                                             |
| 13  | **"What Breathe replaces" strip predated the fitter.** It listed seven point tools and not the one we most directly displace.                    | —                                        | **Fixed** — "AI mask-fitting tool" added to the strip.                                                        |

---

## 3. What changed, file by file

| File                                   | Change                                                                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/breathe-mask-fitting.tsx`       | **New.** The flagship deep dive: three entry points, the six-tier ladder, privacy vs. upload-and-discard, the safeguards, "show your work", the referral portal, "measure it", the head-to-head table, and an honest note on activation.      |
| `pages/breathe-switch.tsx`             | Second page variant (`kind: "fitter"`) for a point solution you run _beside_ a suite rather than migrate off, plus the SleepGlad config. Renders `FitterCompare` instead of the platform table.                                               |
| `pages/breathe.tsx`                    | Fitter added to the deep-dive index (gold) + footer; fitter copy rewritten in the feature card, AI bento and product showcase; new referral-portal feature card; two new compare rows + a cross-link; `REPLACED` strip; pricing add-on blurb. |
| `pages/breathe-features.tsx`           | Fitter promoted to its own capability group; referral portal added to intake; AI cell + role card rewritten; module-toggle bullet; cross-link to the deep dive.                                                                               |
| `pages/breathe-faq.tsx`                | New "Mask fitting" group (6 questions); the mask-fitter photo answer sharpened to name the upload-and-discard distinction.                                                                                                                    |
| `pages/breathe-patient-experience.tsx` | Fitter card rewritten around what the _patient_ now sees (their measurement against the band, safety screened first).                                                                                                                         |
| `App.tsx`                              | Routes + lazy chunks for `/breathe/mask-fitting` and `/breathe/switch/sleepglad`.                                                                                                                                                             |

No new CSS — everything reuses the existing `.bx-*` design system. `/breathe/*`
is excluded from `public/sitemap.xml` by prefix (that sitemap is the tenant
storefront), so the drift guard is unaffected.

---

## 4. Two positioning decisions worth recording

**We do not publish a fitting-accuracy percentage, and that is now the
argument rather than an omission.** SleepGlad markets 97% accuracy; their own
site says ">90%" on another page, and no peer-reviewed validation of the
platform appears to exist. Inventing a competing number would be a business
and legal decision, not an engineering one, and we do not have the
instrumented benchmark to defend one. So the "Measure it" section says
plainly: _we don't quote you an accuracy number, we ship you the dashboard
that measures ours_ — which turns the absence into the more credible claim
and points at a feature that genuinely exists.

**The activation gate is marketed as a feature, not hidden as a caveat.** The
clinical engine ships OFF because the seeded size bands are estimates and an
unreviewed band is capped below high confidence by design. Rather than omit
that, the page has an "One honest note about turning it on" section: your RT
signs off the bands for the models _you_ dispense, against the
manufacturer's own documentation, and that citation prints on every fit
report afterwards. A buyer comparing us with a black box reads that as rigour.
Hiding it and having them discover it in onboarding would read as a bug.

---

## 5. Correction pass — claims that outran the wiring

Automated review of the first draft caught something worth recording, because
it is the exact failure mode this document exists to prevent. Several claims
described the fitting engine's **design** rather than what is **wired
end to end** today. All were corrected before merge; the underlying product
gaps are listed here so they are not rediscovered from scratch.

| Claim as first written                                     | What the code actually does                                                                                                                                                                                                                   | Fix                                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "A blurry or badly-lit scan caps confidence"               | `results.tsx` never sends `scan`, so `fit-assess.ts` substitutes `NEUTRAL_SCAN` (`measurementConfidence: 0.7`) on every fitting. Per-scan blur/lighting is not measured — and 0.7 sits below `highScan` 0.75.                                 | Reworded to the true conservative default: a single unverified frame is scored moderate, never perfect.       |
| Magnetic screening "screens the patient and household"     | The rule set, household scope and hard filter are all real, but when `fitter.magnet_screening` is on the API returns `safety_screen_required` and `results.tsx` falls back to the legacy engine — the questions are never put to the patient. | Reworded to "covers", with an explicit note that the answers come from the chart today.                       |
| "Revising a rule writes a new version, not a deploy"       | `safety_screen_versions` has a read path (`catalog-store.ts`) and a seed migration. No admin route or console UI authors, publishes or retires a version.                                                                                     | Reworded; publishing a revision is stated as a step we run, not a console button.                             |
| Outcomes "split by counter, text, or re-fit outreach"      | `fit_sessions.entry_point` is constrained to `remote_link` / `in_office` / `kiosk_qr` (0483). A re-fit campaign link is recorded as an ordinary remote link.                                                                                  | Re-fit segment dropped from the claim.                                                                        |
| "Every sign-off records a citation"                        | `sourceKind` / `sourceRef` are `.optional()` on the sign-off route; the console offers "Not recorded" and the report prints "source not recorded".                                                                                            | Reworded — and the honest version is the better story: it refuses to invent a citation.                       |
| The `$119` standalone plan listing formulary + fit reports | `MASK_FITTER_ALLOWED_ROUTE_PREFIXES` omits `/admin/fitter/catalog`, `/admin/fitter/formulary`, `/admin/fit-sessions` and `/admin/control-center`, so that scope cannot reach any of them.                                                     | Plan highlights cut to what the scope actually reaches; the clinical console is named as a full-plan feature. |

One real accessibility defect was also fixed, in **both** tables: the
comparison marks conveyed yes/no through a Lucide icon alone, and
`lucide-react` gives an unlabelled icon `aria-hidden="true"` — so a screen
reader met an empty cell on every row. `CompareMark` (pre-existing, on
`/breathe/compare` and every switch page) and the new `FitMark` now carry
visually-hidden "Yes"/"No" text. Note that axe reported **zero** violations on
both pages before this fix — an empty table cell is valid HTML, so automated
scanning could not see it.

## 5a. Update — the gaps were closed, and the copy was restored

The five product gaps above were built in the same pass, so five of the six
softened claims went back to their stronger form. Recorded here because the
sequence matters: the copy was corrected first and restored only once the
code actually backed it.

| Gap                                                  | What shipped                                                                                                                                                                                                                                                  | Copy now                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Scan quality never measured                          | `frame-sampling.ts` + `scan-signals.ts` join the existing (orphaned) checks to the route. `aggregateFrames` now reports `band: "low"` for a frame that failed its own gates, and `resolveConfidence` honours it.                                              | "A blurry or badly-lit scan cannot produce a confident answer" — restored |
| Safety screen never shown                            | `safety-screen.tsx` renders the questions the route demands; `results.tsx` shows it ahead of every other branch and resubmits the attested answers instead of falling through to the legacy engine.                                                           | "The questions are put to the patient" — restored                         |
| No re-fit attribution                                | Migration `0497` adds the `refit_campaign` entry point; `sendRescanForInvite` derives it from the rescan reason.                                                                                                                                              | The re-fit segment — restored                                             |
| No console for safety-rule versions                  | `/admin/fitter/safety-screens` + `routes/admin/safety-screens.ts`: clone the active set to a draft, edit, publish (retiring the incumbent), or retire back to the platform set. Migration `0498` adds the per-org one-active index that makes publish atomic. | "You publish a revised version yourself" — restored                       |
| Standalone plan could not reach its clinical console | The SPA route guard had drifted from the server allowlist; Control Center added for both, scoped to the tenant's own `fitter.*` flags.                                                                                                                        | Catalog / formulary / fit reports back in the plan — restored             |

**Deliberately still qualified:** sign-off provenance. `sourceKind` /
`sourceRef` remain optional, and the report still prints "source not
recorded" rather than inventing a citation. Making provenance mandatory is a
clinical-workflow decision (it would block a reviewer who checked a physical
template they cannot cite), not an engineering one — so the copy continues to
describe it accurately rather than the code being bent to match the copy.

## 6. Still open

- **Social proof.** Unchanged from the June audit: no testimonials, logos, or
  case studies, because we will not fabricate customers. Pre-launch item.
- **A published outcome benchmark.** §4 above is the right answer _today_.
  Once the fitter-outcomes dashboard has real volume behind it, an
  instrumented, methodology-stated number becomes possible — and would be
  much stronger than a vendor claim.
- **Screenshots of the fitting flow.** The home page leads with real captured
  console screens; the new page is text and diagrams. A captured `/results`
  fit diagram would be the highest-value image on the site.
- **Pediatric and NIV service lines.** The data axes are carried, but each
  needs its own clinical validation, so neither is claimed anywhere.
