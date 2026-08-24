# Runbook: Activate the clinical mask fitter

Operator checklist for turning on the clinical fitting core — the Mask
Intelligence Catalog, the tiered assessment engine, magnetic-component
safety screening, and confidence gating — which ships **built but OFF**
(migrations `0481`–`0486`, flags seeded by
[`0485_fitter_clinical_flags.sql`](../../lib/resupply-db/migrations/0485_fitter_clinical_flags.sql)).

Companion to
[`docs/competitor-analysis-sleepglad-2026-08-18.md`](../competitor-analysis-sleepglad-2026-08-18.md),
which explains _why_ this matters commercially. This one is the _how_.

> **The short version.** Until step A is done, do not flip anything. The
> catalog's millimetre bands are **estimates**, and the engine knows it —
> an unreviewed size band can never produce a high-confidence
> recommendation. Turning the master switch on first doesn't ship bad
> recommendations (the cap holds), it ships a fitter that routes almost
> everything to human review, which looks broken. Do the sign-off first.

All seven switches below are **runtime feature flags**, flipped in
**Control Center** (`/admin/control-center`), effective within ~5 s with
no deploy. There are no env-var gates in this subsystem.

---

## A. Prerequisite — clear the clinical review queue

**Who:** a respiratory therapist or clinical supervisor (the queue is
gated on `formulary.manage`, not a generic tools permission).
**Where:** `/admin/fitter/catalog`.
**Effort:** the seed ships ~290 size variants (0486's ~250, plus the
magnet-free twins from `0493` and the Inogen / Rain8 / X30i additions
from `0494`); a tenant only needs the models it actually dispenses.

Why this is a hard prerequisite, in the codebase's own words: the 0486
seed bands are "clinically-reasoned estimates rather than published
manufacturer data," every row lands `needs_clinical_review = true`, and
`lib/fitting/confidence.ts` independently caps an unreviewed variant
below high confidence. The flag is the second line of defence, not the
only one.

Procedure, per model you dispense:

1. Filter to **Showing: needs review** (the default view) and open a
   model's sizes.
2. Open that manufacturer's fitting guide / spec sheet. Where the
   catalog carries a `fitting_instructions_url` (migration `0496`), the
   sign-off panel renders it as **"Open the manufacturer's fitting
   documentation"** — one click instead of a search.
3. Fill in **Sign-off source** — the class of evidence and a reference
   (e.g. "AirFit N20 fitting template rev C"). This is recorded on every
   sign-off you then make and printed on the fit report, which is what
   makes the report evidence rather than an assertion (migration `0491`).
   When the catalog's own band provenance (`0495`) names a single source
   for the model's pending sizes, the form arrives **pre-filled** from it
   — confirm it, or change it to what you actually checked.
4. Check each size's millimetre bands against the guide. A band you
   believe is **wrong** should be **left unsigned** — an unsigned band
   caps confidence, which is the correct outcome for a number you don't
   trust. Platform bands are read-only from the tenant console
   (`platform_row_read_only`); corrections to the shared catalog go
   through a platform migration, so report the discrepancy rather than
   signing it off. (Only a tenant-private mask's bands are editable
   here.)
5. **Sign off all N remaining** for the model, or size by size.

Notes:

- Sign-off is **per tenant**. It lands in `mask_variant_reviews`, never on
  the shared `mask_size_variants.needs_clinical_review` flag — one DME's
  RT must not lift another DME's confidence ceiling.
- The source field is **optional by design**. A reviewer going on
  experience should pick "Clinical judgement (no document)" rather than
  overclaim a citation. Never leave it blank to save time — a blank reads
  as "source not recorded" forever.
- The `0494` additions (Inogen Aurora, Rain8 AmeriFlex, AirFit X30i)
  carry class-generic estimated bands, and for the **Aurora** models the
  S/M/L size run itself is an assumption Inogen has not published —
  verify each size actually exists in the manufacturer's materials before
  signing it off.
- **Check:** filter to needs-review and confirm the models you dispense
  are gone from the queue.

---

## B. Flip the flags, in this order

The order is not cosmetic — 0485's header encodes the dependencies.

### B1. `fitter.clinical_assessment` — the master switch

Makes the engine read the DB catalog and this tenant's formulary at all.
Everything below is inert without it.

- **Precondition:** step A complete for the models you dispense, **and**
  an active formulary published at `/admin/fitter/formulary`.
- **Closed formulary?** Add the magnet-free twins (`0493`:
  `resmed-airfit-f20-non-magnetic`, `resmed-airfit-f30i-non-magnetic`) to
  your allow list. A rule targeting the magnetic parent does **not**
  cover its twin — inheritance was deliberately rejected so an explicit
  `deny` can never be silently widened — and without the allow rule the
  safe SKU sorts behind every allowed mask for exactly the patient who
  needs it.
- **Check:** run a fitting (`/admin/fitter-invites` → complete the link
  yourself) and confirm a `fit_sessions` row appears at
  `/admin/fit-sessions` carrying a formulary version.
- **Rollback:** flip OFF. The legacy engine
  (`lib/storefront/recommendationEngine.ts`) resumes immediately; no data
  is lost and existing fit sessions stay readable.

### B2. `fitter.magnet_screening` — patient-safety screen

Asks the patient (and about their household) about implanted devices, and
excludes masks with magnetic headgear clips on a positive **or unsure**
answer. Requires B1.

- **Precondition:** B1 on. Review the seeded question wording at least
  once — it is what the patient sees and what the report cites
  (`magnetic_implant@v1`).
- **Confirm** the catalog's `has_magnetic_components` is right for the
  models you stock; the exclusion keys off that column. A mask wrongly
  marked magnet-free is the one failure mode that matters here.
  (Migration `0492` corrected eight false negatives against the FDA
  recall list and Philips' 2022 safety notice — re-verify anything you
  stock that isn't from ResMed, Philips or F&P.)
- **Confirm** `magnet_free_variant_slug` is right for the magnetic models
  you stock: it is what lets the engine offer the same mask magnet-free
  instead of pushing the patient to a different model entirely (`0493`).
- **Check:** run a fitting answering "yes" to an implanted device and
  confirm magnetic masks are excluded, with the exclusion visible in the
  fit report's "Ruled out" section.
- **Rollback:** flip OFF. Do this immediately if the screen is firing
  wrongly — an over-exclusion is an annoyance, an under-exclusion is a
  safety issue.

### B3. `fitter.confidence_gating` — exception handling

Low-confidence fittings stop short of an automated recommendation and ask
for a better scan or an RT review instead of guessing. A prescribed
pressure above a mask's rated maximum becomes an exclusion rather than a
scoring penalty. Requires B1 and somewhere to route a review.

- **Precondition:** B1 on, and **someone is actually working**
  `/admin/fit-sessions`. This flag creates a queue; an unattended queue is
  worse than no gating, because patients wait on a review nobody does.
- **Check:** the fit-review queue at `/admin/fit-sessions` receives
  low-confidence sessions and they can be approved or overridden.
- **Rollback:** flip OFF. Gated sessions resolve to a recommendation
  again; already-queued sessions stay reviewable.

### B4. `fitter.fit_profile_v2` — the expanded questionnaire

~20 questions across six short chapters, with branching so a typical
patient answers far fewer. OFF keeps the original 11.

- **Precondition:** B1 on. This one is patient-visible and lengthens the
  flow — watch fitter completion rate at
  `/admin/analytics/acquisition-funnel` after flipping.
- **Rollback:** flip OFF. Answers already captured stay on their sessions.

### B5. `fitter.multiframe_capture` — guided multi-angle scan

Independent of the server work above; can be flipped at any point, on its
own. Guided multi-angle capture with live quality checks (lighting,
distance, head position, obstruction, movement).

- **Precondition:** none beyond wanting it. Still patient-visible — watch
  the capture drop-off in the acquisition funnel, and the scan-failure
  reason mix.
- **Rollback:** flip OFF; capture returns to single-frame.

### B6. `fitter.clinical_report` — already ON

Seeded **ON** and staff-only. Nothing to do. Leave it on: it is the
downloadable PDF that makes every step above auditable.

### B7. `fitter.lead_capture_only` — already ON, and the one to leave alone

Seeded **ON for every tenant** (migration 0518), which is what makes the
fitter end in a **request a person works** rather than an order the
patient files themselves.

With it ON, `/results` offers two ways out — _send my details_ and _ask
a representative to contact me_ — and both land in
**Fitter → Fit Requests** (`/admin/fitter-requests`) as a
`resupply.fitter_fit_requests` row. Nothing is ordered, billed or
shipped until somebody works that row. Insurance details on the form are
**optional by design**: staff verify benefits either way, so a patient
who can't find their member ID is not stuck.

`POST /api/orders` (the old self-serve insurance order) **refuses** while
this flag is on — hiding the button is not a control, and the endpoint is
public. It fails toward ON: a flag lookup that never reached the tenant's
row reads as enabled, in the SPA and in the route alike, because the safe
reading of "we don't know" is that a patient may not start a claim from
their own guess at a member ID.

- **Precondition:** none. Unlike B1–B5 this is not a clinical switch.
- **Turning it OFF** restores the patient-submitted insurance order at
  `/order`. Only do that if you actually want patients filing their own
  orders unreviewed.
- **Where the requests go:** `/admin/fitter-requests`, gated on
  `conversations.manage` — the same CSR scope as Insurance Leads. The
  matching prospect row in **Fitter Prospects** is stamped
  `contact_requested_at` so the funnel view shows who raised their hand.

#### Closing a request — say how it turned out

Every request closes with an **outcome** (migration 0519), chosen on the
row beside the status:

| Outcome                                | Use it when                                        |
| -------------------------------------- | -------------------------------------------------- |
| **Fulfilled — patient has their mask** | The equipment actually reached them.               |
| **Not proceeding**                     | They decided against it, or aren't eligible.       |
| **Couldn't reach them**                | Contact attempts were exhausted.                   |
| **Duplicate**                          | The same person is already being worked elsewhere. |

**Fulfilled is the one that leaves this queue.** It stamps the linked
fitting as dispensed, which is what feeds the dispense rate and the
accepted-vs-overridden split on **Analytics → Fitter outcomes**, and what
lets the re-fit campaign know which mask a patient is actually on. The
other three record the close and nothing more.

So: only mark **Fulfilled** once the patient genuinely has the mask — not
when the order is placed. A queue tidied up by closing everything as
fulfilled reports a dispense rate that is simply untrue, and the re-fit
campaign will then chase people about masks they never received.

The outcome can also be set (or corrected) on an already-closed request
without re-opening it. Re-opening a request clears its outcome, because a
request being worked again has not turned out yet; the dispense date it
already stamped is **not** rolled back — that fact stays true.

#### Duplicate submissions

A patient who double-taps _Send_, or goes back and submits again, does
**not** create a second row and does **not** send you a second email. The
database holds one open request per person per ask; a re-submit is folded
into the request you already have, and anything new they typed the second
time (an insurance card they'd since found, say) is added to it. Nothing
they supplied the first time is ever blanked, and nothing you have
written on the row — status, note, who made contact — is touched.

Once you **close** a request, the same patient can file a fresh one. That
is deliberate: a person coming back weeks later is a new ask, not a
duplicate. Two fittings are also two requests even from one person — a
parent who fits themselves and then their child gets a row each, because
the dedupe key includes who the fitting is _for_, not just who is asking.

> **One-off, on the deploy that introduces this:** requests that were
> already sitting open when migration `0519` shipped predate the dedupe
> key, so a re-submit of one of _those_ can still produce a second row.
> It cannot be back-filled — the key is a hash computed in the
> application, and storing the raw name/email/phone to compare instead
> would put patient details in a column that exists only to be matched.
> The window closes as staff work the pre-existing queue down. If you see
> an obvious pair in the first day or two, close one as **Duplicate**.

### B8. The adult-or-child question — not a flag

The questionnaire now opens with **"Who is this fitting for?"** on both
question sets, and the answer is a **service line**, not an age. There is
no toggle: it selects the measurement plausibility window, the tier-1
service-line filter, and the `population` column on the stored fit
session, all of which silently default to _adult_ when unset.

A **pediatric** session is fitted from the DB catalog's pediatric models
(`resmed-pixi`, `philips-wisp-pediatric`, `sleepnet-minime-2`,
`circadiance-sleepweaver-advance-pediatric`), and adult-only interfaces
are excluded outright. On the **legacy** `/api/recommend` path — a tenant
with B1 off — the built-in catalog carries no pediatric interfaces and no
pediatric size bands, so a child ranks nothing and the page says so
plainly and offers the callback, instead of sending a parent back to the
camera for a photo that was never the problem.

---

## C. The re-fit campaign is gated twice — flag alone does nothing

`fitter.refit_campaign` (migration `0490`, seeded OFF) offers a fresh fitting
to patients who reported a leaking or uncomfortable fit, and to patients on a
discontinued mask. Unlike the flags above it needs **two** switches:

1. **`RESUPPLY_REFIT_CAMPAIGN_ENABLED=1`** on Railway (Service → Variables).
   This registers the worker at boot; without it the job never starts and the
   flag has nothing to enable. Takes effect on the next deploy.
2. **`fitter.refit_campaign`** ON in Control Center, per tenant.

Flipping only the flag is the failure everyone hits: the toggle reads as ON
and nothing is ever sent, with no error anywhere. Set the variable first,
confirm the deploy, then flip the flag.

- **Precondition:** the tenant's SMS and/or email sender is configured, and
  patient consent for those channels is in order — this contacts patients who
  did not ask to be contacted.
- **Check:** after a nightly run (19:20 UTC), look for a
  `refit_campaign.tick` log line with a non-zero `sent`.
- **Rollback:** flip the flag OFF; sending stops within ~5s, no deploy needed.

---

## C2. Dropping a manufacturer you no longer carry

**Where:** `/admin/fitter/formulary` → **Manufacturers**.
**Who:** `formulary.manage`.
**Takes effect:** within ~60 s (the fitting-context cache TTL); no deploy,
no flag.

When you stop carrying a line — on price, on a contract change, on
anything — flip that manufacturer to **Hidden**. Their masks then
disappear from:

- the clinical fitter (`/api/fit/assess`) and its catalog browse,
- the legacy recommendation engine (so it survives a `B1` rollback),
- `/masks`, the storefront's mask browse page,
- the storefront assistant — both its catalog tools _and_ the mask list
  in its system prompt,
- the shop's product grid and search, for products whose Stripe
  `metadata.manufacturer` names that brand.

**Hidden is not the same as "Do not dispense."** The distinction is the
whole reason both exist:

|                              | Where it lives      | What the patient sees                                               | What a clinician sees                                                          |
| ---------------------------- | ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Hidden**                   | Manufacturers panel | Nothing. It is gone.                                                | Nothing in the result; the withheld slugs are in the fit session's provenance. |
| **Do not dispense** (`deny`) | Add-a-rule form     | Ranked last, flagged "not part of your provider's usual selection". | The mask, still there, when the clinical tiers leave nothing else.             |

Use `deny` when you still _can_ dispense it and would rather not — it
keeps the clinical safety net. Use **Hidden** when you genuinely cannot,
because showing a patient a mask you can't order sets up a conversation
somebody then has to walk back.

Notes:

- **The switch refuses to starve a patient.** Hiding a brand that would
  leave any synthetic profile with no dispensable mask returns
  `formulary_would_exclude_all` and saves nothing. Add the replacement
  line to the catalog first (step A), then hide the old one.
- **Keeping one model of a dropped line** is a rule, not a toggle: hide
  the manufacturer, then add an **Allow** rule targeting that one mask
  model. Target specificity does the rest. The panel then shows the brand
  as shown-with-_n_-hidden rather than hidden.
- **Scoped exclusions stay yours.** If a brand is hidden by a rule scoped
  to one location or payer, the toggle reports it but will not remove it
  — edit that rule in the rule list instead.
- **A database hiccup fails open.** The catalog degrades to the built-in
  fallback with an open formulary, so a hidden brand can reappear for the
  duration. That is the storefront's standing service-boot trade (a
  merchandising slip beats an outage), not a bug to chase.
- **Check:** `/admin/fitter/formulary` → **Test a scenario**. Denied masks
  are now labelled `Hidden` or `Demoted` per face, with counts in the
  header badges.

---

## D. What makes the outcome KPIs fill in

`/admin/analytics/fitter-outcomes` reads columns that only certain actions
write, so two of its tiles stay empty until the matching workflow is
actually being used. This is not a bug to chase:

| Tile                        | Fills in when                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Recommendation accepted** | A clinician approves or overrides a fitting in the review queue. Until someone works the queue every fitting is _undecided_, which is honest — nobody has judged it.                                   |
| **Dispensed**               | A cash-pay order that came from a fitting is marked **delivered** (carrier webhook, or the admin "mark delivered" action). Payment alone does not count: a mask in a warehouse has not been dispensed. |

Two consequences worth stating plainly, because they look like data loss:

- **Insurance fittings never count as dispensed.** "Choose this mask" creates
  an order request, not a shop order, and the link column is a foreign key to
  `shop_orders`. Dispensing measures the cash-pay path only.
- **A fitting only links to an order placed from the fitter's own
  "Buy without insurance" button**, within 24 hours, in the same browser. A
  patient who browses the shop separately and buys the same mask is a
  different journey and is deliberately not attributed to the fitting.

---

## Recommended order

1. **A** — clear the review queue for the models you dispense. Everything
   else is blocked on this.
2. **B1** `fitter.clinical_assessment`, then watch one real fitting end to
   end before continuing.
3. **B2** `fitter.magnet_screening` — the safety win, and the one with a
   published clinical rationale behind it.
4. **B3** `fitter.confidence_gating` — only once someone owns the review
   queue.
5. **B4** / **B5** — patient-visible polish; flip one at a time and watch
   completion rate between them.

## Rollback

Every flag is independently reversible in Control Center with no deploy
and no data migration. Flipping `fitter.clinical_assessment` OFF disables
the whole subsystem in one action regardless of the others' state — that
is the panic switch.

Clinical sign-offs in `mask_variant_reviews` survive a rollback, so
re-enabling later does not mean redoing step A.
