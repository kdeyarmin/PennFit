# DME billing software & Office Ally — market research and accuracy/usability assessment

**Audience:** Penn Home Medical Supply ownership + engineering.
**Date:** 2026-06-09.
**Question asked:** _"Research DME billing software and Office Ally for billing
DME claims, and ensure that we have the most accurate and easiest-to-use
billing software for DME companies."_

**Method:** (1) market scan of the commercial DME/HME billing platforms and the
clearinghouse landscape (June 2026); (2) a code-verified inventory of PennFit's
own billing suite — the X12 builders/parsers in
`lib/resupply-integrations-office-ally`, the `lib/billing/*` logic, the
`/admin/billing/*` routes and SPA pages, and the `insurance_claims` schema; (3)
a gap analysis that maps the DME-specific accuracy traps from the market scan
onto what PennFit actually emits and how an operator drives it.

> Companion to [`office-ally-go-live.md`](./runbooks/office-ally-go-live.md)
> (how to turn Office Ally on), [`dme-app-improvements-2026-06-06.md`](./dme-app-improvements-2026-06-06.md)
> (full feature inventory), and
> [`office-ally-realtime-eligibility-scope-2026-06-08.md`](./office-ally-realtime-eligibility-scope-2026-06-08.md)
> (real-time 270/271). This doc is the **billing-specific** verdict the others
> don't give in one place.

---

## TL;DR

1. **Office Ally is the correct clearinghouse for a Pennsylvania CPAP/DME
   supplier**, and PennFit is already wired to it correctly. It submits par
   (in-network electronic) claims **free**, reaches the Medicare **DME MACs via
   CEDI** (PA is **Noridian Jurisdiction A**), and exposes a real-time 270/271
   API that PennFit already integrates. The only recurring cost is ERA
   (835) retrieval (~$35/mo) and a per-Tax-ID non-par surcharge. No reason to
   move off it; switching clearinghouses is a payer-enrollment project, not a
   software upgrade.

2. **PennFit's billing engine is already more capable than the off-the-shelf DME
   packages on the dimensions that move cash** — AI claim scrubbing, denial
   prediction, an integrated resupply-outreach annuity, and a 107-payer profile
   catalog — and at least at parity on the X12 backbone (837P / 835 / 270-271 /
   276-277 / 277CA / 999). Brightree/Bonafide/NikoHealth/WellSky win on **payer
   breadth, fax, form-fill (CMN/DWO), and "legacy-friendly" last-mile plumbing**,
   not on claim accuracy or workflow intelligence.

3. **"Most accurate"** is true today. A line-by-line code verification (see
   the **Verification update** below) found that almost everything the first
   draft of this doc listed as a "gap" is **already shipped** — CMN/DWO PDF
   generation, line-level COGS, 276/277 claim status, secondary-COB, and
   automatic payer-modifier stamping all exist and are wired. The one genuine
   accuracy gap was the **NTE narrative for miscellaneous/NOC HCPCS** (E1399,
   A9999, …), which Medicare DME requires; that has now been **closed in this
   PR** (837P builder + DB column + preflight block — §5). One capability is
   deliberately built-but-dormant: the **line-level ordering-provider loop
   (2420E)**, shipped in the builder, off by default pending a live 277CA
   validation.

4. **"Easiest to use"** is in similarly good shape. The last-mile pieces the
   first draft flagged are mostly built — a **276/277 claim-status** path, a
   **one-click secondary-COB worklist**, and **outbound fax for appeal
   letters** all exist. The remaining usability seams are narrow (§6): fax
   **dispatch** for prior-auth request forms (appeals already fax), and a full
   CMS-484 _clinical_ PDF (the DWO/CMN _cover_ already renders).

**Bottom line:** keep Office Ally; PennFit already _is_ a best-in-class DME
billing system for a tech-forward single-location supplier — materially more
complete than the first pass of this research assumed. The single real accuracy
gap is closed in this PR; what remains (§5–§6) is a short, well-scoped list, and
none of it requires switching vendors or re-architecting.

---

## Verification update (2026-06-09, same day)

> The gap analysis in the first draft was built from a **route-only** survey of
> the codebase and **overstated what's missing**. A follow-up pass that traced
> each capability through its full stack (library → mounted route → admin SPA
> page) corrected it. The corrected verdicts are folded into §5–§7 below; the
> raw findings:
>
> | Capability | First-draft claim | **Verified state** | Evidence |
> | --- | --- | --- | --- |
> | NTE narrative (NOC HCPCS) | missing | **shipped in this PR** | `edi/837p.ts`; `0248_claim_line_narrative.sql`; `claim-preflight.ts` |
> | Line-level ordering provider (2420E) | missing | **builder shipped, off by default** | `edi/837p.ts` (gated pending live 277CA) |
> | CMN / DWO form generation | "tracked only, manual" | **DONE** (PDF + route + worklist) | `lib/billing/dwo-pdf.ts:143` `renderDwoPdf()`; `routes/admin/dwo-documents.ts` `GET …/pdf`; `cmn-documents.ts`; `admin-billing-cmn-worklist.tsx`. _Refinement open:_ the full CMS-484 **clinical** questionnaire PDF (the cover renders today). |
> | Line-level COGS | missing | **DONE** | `lib/billing/claim-builder.ts:314-325` stamps `unit_cost_cents`/`cost_source` (migration 0193) |
> | 276/277 claim status | "no workflow" | **DONE** | `lib/billing/claim-status-checker.ts`; `routes/admin/claim-status.ts`; inbound-277 poller |
> | Secondary-COB UI | "logic only" | **DONE** | `routes/admin/secondary-claims.ts` (worklist + one-click `generate-secondary` + line copy); `admin-secondary-claims.tsx` |
> | Modifier stamping | "not on manual claims" | **DONE (auto); N/A for manual** | `claim-builder.ts:327-368` auto-applies `payer_modifier_rules`; manual claims are intentionally header-only (corrections/voids carry no lines) |
> | Outbound fax | "missing" | **DONE for appeals; PA dispatch open** | `lib/resupply-telecom/src/telnyx-fax.ts`; `routes/fax/document.ts` renders appeal PDFs; `claim-appeals.ts` faxes. `prior-auth-request-form.ts` produces a faxable PDF + destination but doesn't auto-dispatch |

---

## 1. The DME/HME billing software market (June 2026)

DME billing software splits into two layers people conflate: the **practice-
management / billing platform** (the system of record that builds claims and
runs the revenue cycle) and the **clearinghouse** (the pipe that transmits X12
to payers). PennFit competes with the first; Office Ally _is_ the second.

### 1.1 Commercial DME/HME platforms

| Platform | Strongest at | Notes |
| --- | --- | --- |
| **Brightree** (ResMed) | Medicare FFS depth, scale, ecosystem | Market leader; quote-based pricing, often revenue-share/per-claim; rated middling on usability/value vs. price. |
| **Bonafide** | Feature breadth for larger HME | Rated higher than Brightree on capability, but more expensive to implement. |
| **NikoHealth** | **Ease of use + workflow automation**, transparent flat pricing | Repeatedly cited as the usability benchmark; lighter on Medicare-Advantage quirks. |
| **WellSky / CareTend** | Complex commercial + infusion/pharmacy | Depth for mixed HME + respiratory + infusion. |
| **TIMS, Universal Software Solutions (HDMS), Nymbl** | Structural claims workflow | Solid claims engines; vary on resupply/outreach. |

Two findings from the scan are decisive for positioning PennFit:

- **No commercial platform does intake validation + prior-auth tracking +
  resupply outreach + denial intelligence well natively.** Operators bolt on
  Power BI/Tableau for reporting and separate tools for outreach. PennFit's
  resupply engine + AI denial layer is exactly the gap they leave open.
- **The market is converging on automation as the differentiator.** Vendors
  market "denial prediction" and "first-pass acceptance" as the 2026 story;
  operators using denial-prediction scoring report **12–18% reductions in
  first-pass denials within 90 days**. PennFit already ships this
  (`lib/billing/denial-risk.ts`, `claim-preflight.ts`) — it's not a roadmap
  item, it's built.

### 1.2 DME billing is an accuracy minefield — the traps that cause denials

Industry DME denial rates run **15–25%**. The recurring root causes (which a
billing system is judged on whether it prevents) are:

1. **Expired/missing CMN, DWO, or SWO** (Detailed/Standard Written Order).
2. **Eligibility gaps** — coverage inactive or wrong plan at date of service.
3. **Modifier errors** — especially **KX** (medical-necessity attestation),
   and the rental sequence **RR → NU/UE**. _Rule:_ `GA`/`GZ`/`GY` and `KX`
   must never appear on the same line, or the claim denies as unprocessable.
   Bilateral items bill on **two lines, RT and LT, 1 unit each** — not RTLT on
   one line.
4. **Capped-rental math** — CPAP (E0601) is a 13-month capped rental; the
   correct rental-month modifier sequence and the post-cap patient-
   responsibility carve-out must be automatic.
5. **Same-or-Similar** — Medicare denies a second device if a same/similar
   item is already on file (HETS check).
6. **Miscellaneous/NOC HCPCS** (E1399, A9999, K0108) **require an NTE
   narrative + MSRP** on the claim, or they reject.
7. **Timely filing** — Medicare DME is 365 days; many MA/commercial plans are
   far shorter (90–180 days).
8. **Ordering provider not PECOS-enrolled** — Medicare DME edits verify the
   ordering provider against PECOS.

§5 maps each of these onto what PennFit emits today.

---

## 2. The clearinghouse landscape — and why Office Ally is right

| Clearinghouse | Claim submission | ERA / extras | Best fit |
| --- | --- | --- | --- |
| **Office Ally** | **Free** for par claims | ERA ~$35/mo; non-par surcharge per Tax-ID+NPI/mo | Small–mid practices; **PennFit's choice** |
| **Claim.MD** | $0.15–0.25/claim | Feature-rich at low cost | Small–mid, API-forward |
| **Availity** | Free–low | Widest payer connectivity | Mid; strong commercial reach |
| **Waystar** | Subscription $200–800/mo | Heavy automation | Mid–large, staff-time savings |
| **TriZetto / Optum (Change)** | $0.15–0.40/claim, volume | Enterprise | Large practices |

**Verdict: stay on Office Ally.** For a single-location PA CPAP/DME supplier:

- **Cost** is the lowest in the market — free electronic par claims; the only
  fixed cost is ERA retrieval. There is no per-claim fee eating into a $100–300
  resupply claim.
- **DME MAC reach is covered.** Office Ally reaches the Medicare DME MACs
  through **CEDI** (Common Electronic Data Interchange), the CMS front-end for
  DMEPOS. PA bills the **Noridian Jurisdiction A DME MAC** for CPAP/PAP
  supplies; PennFit already seeds this as the `medicare_dme_noridian` payer
  profile. (CGS Jur B/C payer IDs 17013/18003; Noridian Jur D 19003 — relevant
  only if the supplier expands jurisdictions.)
- **Real-time eligibility** is available via Office Ally's EDI REST API v2
  (`edi.officeally.io`, `POST /v2/eligibility-benefits/x12`), which PennFit
  already integrates as an optional fail-soft path.
- **Switching cost is high and the benefit is low.** What you can exchange is
  defined by the **X12 transaction set**, which is identical across
  clearinghouses; a different clearinghouse buys payer breadth or automation
  tooling, not new claim capability — and re-enrolling every payer's EDI
  routing is a multi-week project. There is no accuracy reason to switch.

**One caveat for go-live (not a software item):** DME MAC electronic submission
requires the **supplier** to enroll in CEDI; a clearinghouse/billing service
**cannot sign the enrollment** on the supplier's behalf, and the supplier's
legal name must match PECOS exactly. This belongs in the go-live runbook's
checklist — see the recommendation in §7.

---

## 3. What PennFit already has (code-verified)

PennFit is **not** "a storefront with some billing." It is a full X12 5010
revenue-cycle engine. Verified in the tree on this branch:

**EDI transactions** (`lib/resupply-integrations-office-ally/src/edi/`):

| Txn | File | Role |
| --- | --- | --- |
| **837P** claims | `837p.ts` | 5010X222A1 claim builder (see §4) |
| **270/271** eligibility | `270.ts`, `parse-271.ts` | Build inquiry / parse benefits; service-type `12`/`B0`/`30` |
| **276/277** claim status | `276.ts`, `parse-277.ts` | Build status request / parse status |
| **277CA** | `parse-277ca.ts` | Acknowledgment / front-end rejection classification |
| **835** remittance | `parse-835.ts` | BPR/TRN/CLP/CAS/SVC/PLB — claim- and line-level adjustments |
| **999** | `parse-999.ts` | Functional ack (syntax accept/reject) |

Transports: SFTP batch (`transport/sftp.ts`) + real-time REST
(`transport/realtime.ts`); stub/outbox mode when unconfigured.

**Billing logic** (`artifacts/resupply-api/src/lib/billing/`): eligibility
verifier, ERA reconciler + payer resolver, denial-risk scoring, claim preflight,
coverage-eligibility gate, capped-rental math.

**Routes** (`artifacts/resupply-api/src/routes/admin/`): manual/corrected/void
claim entry, fulfillment→claim auto-draft, batch submit, ERA ingest, denials &
eligibility worklists, prior-auth queue + renewal + **Da Vinci PAS** FHIR
submit, payer/fee-schedule/modifier-rule/denial-code config, A/R aging, timely-
filing, collections forecast, billing-director KPIs, AI scrub/auto-submit
queues.

**SPA** (`artifacts/cpap-fitter/src/pages/admin/`): a full Billing Hub with
~25 pages — manual claim, config (org/payers/fee schedules/modifier
rules/denial codes/templates/clearinghouse), AI queue, auto-submit, eligibility,
ERA, denials, capped rentals, CMN worklist, prior auths, Office Ally status,
aging, timely filing, statements, collections forecast.

**Schema** (`lib/resupply-db/drizzle/`): `insurance_claims` (+ line items +
append-only events), `era_files` (SHA-256 dedupe), `payer_profiles` (107 rows),
`prior_authorizations`, `denial_codes` (CARC/RARC), `payer_fee_schedules`,
`product_hcpcs_map`, `payer_modifier_rules`, `claim_templates`,
`claim_scrub_results`, `claim_appeal_letters`, `office_ally_submissions`.

**Against the commercial platforms, PennFit already exceeds them on:** AI claim
scrubbing + denial root-cause analysis, denial **prediction** at preflight, the
integrated resupply-outreach annuity (the single biggest revenue lever in the
resupply market), and a verified PA-routing catalog. It is at **parity** on the
X12 backbone.

---

## 4. Accuracy of the 837P generator — direct review

`lib/resupply-integrations-office-ally/src/edi/837p.ts` (842 lines) was read
line-by-line. It is **high quality** and DME-correct on the essentials:

- Correct 5010 envelope (ISA/GS `005010X222A1`/ST/BHT/SE/GE/IEA), monotonic
  control numbers, strict element sanitization (no escape-char smuggling).
- **DME billing-provider taxonomy** `PRV*BI*PXC*332B00000X` (DME & Medical
  Supplies) — the correct provider taxonomy for a DMEPOS supplier.
- Place of service defaults to **`12` (patient's home)** — correct for DME.
- **CLM02 is recomputed from the sum of service lines**, so a drifted stored
  header total can't produce a claim whose total ≠ Σ(lines) (a common
  front-end rejection). This is a genuinely careful touch.
- Claim frequency `1`/`7`/`8` with **REF*F8** original-claim-number on
  replacement/void — correct corrected-claim handling.
- Prior-auth **REF*G1**; ICD-10 diagnoses with **ABK/ABF** qualifiers and
  per-line diagnosis pointers; up to 4 modifiers per line.
- **Loop 2310B** rendering provider, **loop 2310D** referring/ordering
  physician (`NM1*DN`) — emitted for Medicare DME; **loop 2320/2330** COB with
  prior-payer-paid `AMT*D`.

**The DME-specific gaps (real, but edges — not bread-and-butter bugs):**

1. **No NTE narrative segment.** Miscellaneous/NOC HCPCS (E1399, A9999, K0108)
   **require** an NTE narrative (loop 2300 or 2400) describing the item + MSRP,
   or the DME MAC rejects. The builder emits no NTE at either level. CPAP
   resupply rarely uses NOC codes, so this is infrequent — but when a non-
   catalog accessory is billed under E1399, the claim will deny. _Files:_
   `837p.ts` (add optional `claimNote`/`lineNote` → `NTE*ADD`).
2. **Ordering provider at claim level only (2310D `DN`), no line-level loop
   2420E (`DK`).** Medicare DME edits verify the **ordering** provider is
   PECOS-enrolled; the claim-level referring loop is generally accepted, but
   the strict DMEPOS convention is the line-level ordering provider. Low-
   probability rejection risk; worth confirming against the first live 277CA
   batch rather than pre-emptively rewriting.
3. **No CMN/DWO/SWO embed.** Correct — CMNs aren't embedded in the 837P (they
   were largely retired by CMS and travel as separate documentation). This is
   **not** an EDI gap; it's the **form-generation** gap in §5.

Everything else the builder omits (rendering loops 2310A/C, line-level NDC for
drugs) is correctly out of scope for CPAP/DME resupply.

---

## 5. Accuracy — the open list (post-verification)

After the verification pass the accuracy list collapses to one shipped fix and
two follow-ons:

| # | Item | DME impact | Status / effort | Where |
| --- | --- | --- | --- | --- |
| A1 | **NTE narrative for NOC/misc HCPCS** (E1399 etc.) — required by Medicare DME | Denial on every narrative-less NOC line | **DONE (this PR)** — `NTE*ADD` in builder; `narrative` column; preflight ERROR blocks submit until set | `edi/837p.ts`; `0248_claim_line_narrative.sql`; `office-ally-batch.ts`; `claim-preflight.ts` |
| A2 | **Line-level ordering-provider loop 2420E (`DK`)** | Possible Medicare DME PECOS edit rejection; today relies on 2310D being accepted | **Built, dormant** — capability + tests shipped; activate the per-line wiring only after a live 277CA confirms 2310D is rejected | `edi/837p.ts` (`ServiceLine.orderingProvider`) |
| A5 | **Full CMS-484 _clinical_ CMN PDF** | The DWO/CMN **cover** renders today; the answered clinical questionnaire doesn't | **S–M**, optional — most CMNs were retired by CMS; low frequency | `lib/billing/cmn-forms.ts` (Q&A model), `dwo-pdf.ts` (cover renderer to extend) |

**Already covered (do not re-build):** line-level COGS (`claim-builder.ts`,
migration 0193); the **modifier/KX/capped-rental** traps from §1.2
(`payer_modifier_rules` conditions `if_rental_month_le_3` / `_ge_4` /
`if_compliant_90day` + capped-rental automation + `admin-billing-capped-rentals`);
eligibility enforced at order-confirm and claim-preflight via the cached 271.
Same-or-Similar stays a manual HETS entry (automating the HETS 270 needs a CMS
HETS connection).

---

## 6. Ease of use — the open list (post-verification)

The last-mile is far more built than the first draft assumed. Verified present:
the **276/277 claim-status** path (`claim-status-checker.ts` +
`routes/admin/claim-status.ts` + inbound-277 poller), the **one-click
secondary-COB worklist** (`secondary-claims.ts` + `admin-secondary-claims.tsx`),
and **outbound fax for appeal letters** (`telnyx-fax.ts` + `routes/fax/document.ts`
+ `claim-appeals.ts`). Manual claims are intentionally header-only, so there is
no "stamp modifiers on manual claims" gap — fulfillment-derived claims auto-stamp
via `claim-builder.ts`. What's genuinely left:

| # | Gap | Why it hurts usability | Effort | Where |
| --- | --- | --- | --- | --- |
| U1 | **Prior-auth request forms aren't auto-faxed.** The route renders a faxable PDF + returns the payer fax number, but a CSR still kicks off the send (appeal letters already auto-fax). | One manual step the appeal path doesn't have | **S** — mirror the `claim-appeals.ts` → `fax/document.ts` signed-URL + `sendFax()` pattern | `routes/admin/prior-auth-request-form.ts`; `lib/billing/pa-request-pdf.ts` |
| U6 | **No admin UI field for the new line `narrative`.** A1 ships the API + preflight block; the SPA line editor doesn't expose the field yet. | CSR sets the narrative via API/scrubber, not a form input | **XS** | `artifacts/cpap-fitter/src/pages/admin/` claim line editor |

NikoHealth's reputation as "easiest to use" is built on automating exactly this
last mile — and PennFit is already there on the big pieces (claim status,
secondary COB, appeal fax), on top of a denial-intelligence layer Niko doesn't
have. U1 + U6 are the small remaining seams.

---

## 7. Recommendations

**Keep:**

- **Office Ally** as the clearinghouse. It's the right cost/reach fit; switching
  has high enrollment cost and no accuracy benefit.
- The current X12-builder architecture (content cleanly separated from
  transport) — it's why real-time eligibility was a contained add and why A1/A2
  are isolated changes.

**Done in this PR:**

- **A1 — NTE narrative end-to-end** (the one real accuracy gap): `NTE*ADD` in
  the 837P builder, a `narrative` line column (migration 0248), the line PATCH
  endpoint, the batch mapping, and a preflight **error** that blocks submit
  when a NOC/miscellaneous HCPCS line has no narrative.
- **A2 capability** — line-level ordering-provider loop 2420E in the builder,
  off by default (tests included), ready to activate.

**Do next (short, post-verification list — highest value first):**

1. **U6 — surface the `narrative` field in the SPA line editor.** Finishes A1's
   last mile so a CSR types the narrative in a form, not the API. (XS)
2. **U1 — auto-fax prior-auth request forms.** Mirror the appeal-letter fax
   path; the PA PDF + payer fax number already exist. (S)
3. **A2 activation** — wire the per-line ordering provider into the live claim
   path **only after** a live 277CA batch confirms 2310D is being rejected.
4. **A5 — full CMS-484 clinical CMN PDF** — optional; the cover already renders
   and CMNs are mostly retired. (S–M)

Everything else the first draft listed (CMN/DWO cover PDF, line COGS, 276/277
status, secondary COB, modifier auto-stamp) is **already shipped** — see the
Verification update.

**Operational (no code):**

- Add a **CEDI enrollment** step to
  [`office-ally-go-live.md`](./runbooks/office-ally-go-live.md): the supplier
  (not the clearinghouse) must enroll for DME MAC electronic submission, legal
  name must match PECOS, and the **usage indicator stays `T` until a clean test
  271 + 277CA + 835 cycle**, then flips to `P`.

---

## Sources

- [SynergyIQ — DME software comparison 2026](https://synergyiq.net/dme-software-comparison.html)
- [ITQlick — Brightree DME/HME reviews & alternatives](https://www.itqlick.com/brightree-dme-hme)
- [NikoHealth — what is DME billing / best practices](https://nikohealth.com/what-is-dme-billing/)
- [Office Ally — 837P companion guide & payer list](https://cms.officeally.com/all-payers-list-2-0-claims-837)
- [One O Seven RCM — top 10 clearinghouses 2026 (pricing)](https://oneosevenrcm.com/top-10-clearinghouses-in-medical-billing/)
- [Noridian JD DME — electronic claim submission / CEDI](https://med.noridianmedicare.com/web/jddme/claims-appeals/cedi)
- [CGS & Noridian DME MAC tools & resources](https://cgsmedicare.com/pdf/dme/cgs_and_noridian_tools_and_resources.pdf)
- [Noridian — modifiers (KX/RT/LT, capped rental)](https://med.noridianmedicare.com/web/jddme/topics/modifiers)
- [SybridMD — HCPCS E1399 documentation & NTE narrative](https://sybridmd.com/blogs/hcpcs/hcpcs-code-e1399/)
- [CMS — referring/ordering provider, loops 2310A/2310D/2420E](https://www.cms.gov/Outreach-and-Education/MLN/WBT/MLN4462429-MLN-WBT-1500/1500/lesson04/07/index.html)
- [Clustox — why 18% of DME claims get denied](https://www.clustox.com/blog/claims-processing-software-dme/)
- [AnnexMed — DME CPT/HCPCS/modifiers guide 2026](https://annexmed.com/dme-cpt-codes)
</content>
</invoke>
