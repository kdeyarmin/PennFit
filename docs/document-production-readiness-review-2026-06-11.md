# Document Production-Readiness Review — 2026-06-11

Scope: the patient-facing and payer-facing documents PennFit generates,
assessed for completeness and against the governing Medicare / payer /
federal requirements. This is an engineering + compliance content review
of the generators and templates, not a legal opinion and not an
accreditation audit.

Reviewer note on the business owner's question — "Verify they are
Medicare and other payor approved and ready to be sent." No payer,
including Medicare, pre-approves a supplier's generated paperwork. See
the section **What "Medicare approved" actually means** below. The
practical question this review answers is: do the generated documents
carry the content elements those programs require, and are any of them
using a federally controlled layout that must be the official form?

> **Status note (same change-set):** the company-information work that
> ships alongside this review already addresses several findings below:
> the intake-form bodies now have the company name substituted from the
> admin-saved `dme_organization` row at serve time (§2.14), the
> `FALLBACK_COMPANY` placeholder phone `(215) 555-0100` was replaced
> with the real support line (§2.11), the GFE default disclaimer now
> carries the $400 PPDR threshold and the "not a contract" sentence
> (§2.7, DOB/TIN still open), the appeal letter now draws a signature/
> date line (§2.9, structured item/service still open), and the
> `abn_medicare` template description now warns staff it is not the
> official CMS-R-131 (§2.13 — the blocker itself, adopting the official
> form, remains open). The admin page for seeding company identity is
> now surfaced at **/admin/company-information** (alias of
> /admin/billing/config/organization).

Files reviewed:

- `artifacts/resupply-api/src/lib/billing/{cmn-pdf,dwo-pdf,hcfa-1500-pdf,gfe-pdf,pa-request-pdf,appeal-pdf,statement-pdf}.ts`
- `artifacts/resupply-api/src/lib/swo-pdf.ts`
- `artifacts/resupply-api/src/lib/prescription-request-pdf.ts`
- `artifacts/resupply-api/src/lib/provider-portal/signature-log-pdf.ts`
- `artifacts/resupply-api/src/lib/patient-packet/{templates,company}.ts`
- `artifacts/resupply-api/src/lib/intake-forms/catalog.ts`
- `artifacts/resupply-api/src/lib/manual-documents/{catalog,standard-documents}.ts`

---

## 1. Executive summary

Verdict legend: **Ready** (content-complete, no compliance gap found) ·
**Ready-with-conditions** (usable once an operator action is taken —
usually seeding company data, or using it only for its intended
non-Medicare purpose) · **Not-ready** (a real content/compliance gap that
should be fixed before the document is relied on).

| Document                                                              | Verdict               | Primary reason                                                                                                               |
| --------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| SWO (`swo-pdf.ts`)                                                    | Ready-with-conditions | All six 42 CFR 410.38(d) elements present; depends on a linked provider w/ NPI + HCPCS (enforced).                           |
| SWO library template (`standard-documents.ts` `swo_pap`)              | Ready                 | Enumerates all six required elements verbatim; standard wording only.                                                        |
| Standard Written Order via DWO cover (`dwo-pdf.ts`, `formType:"swo"`) | Ready-with-conditions | Cover carries beneficiary/date/item/practitioner/signature; no quantity field — see findings.                                |
| Prescription Request (`prescription-request-pdf.ts`)                  | Ready-with-conditions | Fillable physician order; strong PAP LCD note; validation gates NPI/ICD-10/LON.                                              |
| CMN questionnaire PDF (`cmn-pdf.ts`)                                  | Ready-with-conditions | **Obsolete for Medicare** (CR 12734). Fine only as a commercial-payer artifact; UI must not present it as Medicare-required. |
| CMN via DWO cover / `cmn_484` / `cmn_843`                             | Ready-with-conditions | Same obsolescence caveat; cover only, not the clinical questionnaire.                                                        |
| CMN library template (`standard-documents.ts` `cmn_pap`)              | Ready                 | Wording already states CMS retired CMNs effective 2023-01-01.                                                                |
| CMS-1500 (`hcfa-1500-pdf.ts`)                                         | Ready-with-conditions | Reference/supporting facsimile only — **not** a mailable red-OCR form; several boxes omitted.                                |
| GFE (`gfe-pdf.ts`)                                                    | Ready-with-conditions | NSA content present; **missing the $400 PPDR-threshold disclaimer** and patient DOB.                                         |
| Prior-auth request (`pa-request-pdf.ts`)                              | Ready                 | Carries AHI/RDI, F2F, HCPCS, ordering NPI, LCD criteria reminder. Commercial/MA/Medicaid use.                                |
| Appeal / redetermination (`appeal-pdf.ts`)                            | Ready-with-conditions | Has beneficiary/member ID/DOS/claim #; **no requester signature line**, body is free text.                                   |
| Patient statement (`statement-pdf.ts`)                                | Ready                 | Complete for a balance statement; negative-amount safe.                                                                      |
| Patient packet (`templates.ts`)                                       | Ready-with-conditions | NPP, AOB, rights, financial, POD, supplier standards all present; depends on seeded company data.                            |
| Proof of Delivery (packet + `pod_pap`)                                | Ready                 | Carries all Program Integrity Manual ch. 4 §4.26 elements.                                                                   |
| Supplier Standards notice (packet + `supplier_standards`)             | Ready                 | Abbreviated form is permitted (71 FR 48354); says full text available on request.                                            |
| Intake ABN (`intake-forms/catalog.ts` `abn`)                          | **Not-ready**         | Home-grown paraphrase — **not** the official CMS-R-131. Compliance gap for Medicare.                                         |
| Manual-docs ABN (`standard-documents.ts` `abn_medicare`)              | **Not-ready**         | Same: reproduces the option structure but is not the OMB-approved form.                                                      |
| Intake forms catalog (other entries)                                  | Ready-with-conditions | Hard-coded "PennPaps" name; thin NPP body. Informational acknowledgements only.                                              |
| Signature log / e-sig certificate (`signature-log-pdf.ts`)            | Ready                 | ESIGN (15 U.S.C. ch. 96) attestation + hash-chain verdict; sound.                                                            |

Headline issues, in order of severity:

1. **ABN (both copies) is a home-grown paraphrase, not the official
   CMS-R-131.** Medicare requires the OMB-approved form. **Blocker** for
   any Medicare ABN use.
2. **GFE is missing the $400 patient-provider dispute-resolution (PPDR)
   threshold language and the patient's date of birth.** **Should-fix.**
3. **The cross-cutting fallback identity** (`FALLBACK_COMPANY` =
   "PennPaps" / `(215) 555-0100`, and the billing `stub`/`env` identity)
   will silently print placeholder issuer data on real documents if the
   admin has not seeded `dme_organization`. **Should-fix / operator
   action before launch.**
4. **CMN generators are obsolete for Medicare** (CR 12734). Not a defect
   in itself, but the UI must not present a CMN as a Medicare requirement.

---

## 2. Per-document findings

### 2.1 Standard Written Order — `swo-pdf.ts`

Governing rule: 42 CFR 410.38(d) (the 2020 standardized SWO). Required
elements: beneficiary name (or MBI), order date, general description of
the item, quantity if applicable, treating practitioner name or NPI,
practitioner signature.

| Element                  | Present? | Where                                             |
| ------------------------ | -------- | ------------------------------------------------- |
| Beneficiary name         | Yes      | "Beneficiary → Name"                              |
| Order date               | Yes      | "Order date" (from `generatedOn`)                 |
| Item description + HCPCS | Yes      | "Item ordered" + `describeHcpcs()`                |
| Quantity                 | Partial  | No explicit quantity field; cadence shown instead |
| Practitioner name + NPI  | Yes      | "Treating practitioner"                           |
| Practitioner signature   | Yes      | signature + date line                             |

`validateSwoInputs()` enforces patient name, DOB, HCPCS, a 10-digit NPI,
and provider legal name, returning a 422 list rather than a 500 — good.
The header comment correctly notes MBI and length-of-need are not
required on the SWO itself.

Findings:

- **Quantity is not a discrete element (should-fix, low).** 410.38(d)
  requires "quantity, if applicable." For a CPAP _device_ quantity is
  implicitly 1 and the omission is defensible, but for an order that also
  covers _supplies_ (masks, cushions, filters) the order should state a
  quantity. The renderer shows a replacement cadence ("Every N days")
  rather than a quantity. The library template (`swo_pap`) does carry
  per-item quantities, so prefer that template when the SWO covers
  resupply items, or add a quantity line to the renderer.
- Verdict: **Ready-with-conditions** — content-complete for a device
  order with a linked, NPI-bearing provider.

### 2.2 SWO library template — `standard-documents.ts` `swo_pap`

The body explicitly enumerates all six 410.38 elements and the field
block prefills standard HCPCS quantities (e.g. "A7031 ... qty 1 per
month"). Standard wording only, no PHI. **Ready.**

### 2.3 DWO / CMN cover — `dwo-pdf.ts`

This renders a _cover/order_ page for the `dwo_documents` tracking row in
four flavors: `dwo`, `cmn_484`, `cmn_843`, `swo`. It deliberately does
**not** reproduce a clinical questionnaire.

- For `formType:"swo"` it carries beneficiary, order date, item category,
  ordering practitioner (name + NPI), and a signature line — the 410.38
  elements except an explicit **quantity** (only a free-text "Order
  detail" note). Same quantity caveat as 2.1.
- `cmn_484` / `cmn_843` titles ("Certificate of Medical Necessity
  (CMS-484/843)") refer to forms Medicare **retired** (see 2.5). Keep
  these only for commercial payers that still ask for a CMN cover.
- Verdict: **Ready-with-conditions.**

### 2.4 Prescription Request — `prescription-request-pdf.ts`

A fillable order addressed _to_ the physician (verify/sign/fax back),
distinct from the supplier's own SWO record. Strong points:

- Carries patient, diagnosis (ICD-10 with labels), equipment table with
  HCPCS + qty + cadence, device settings, length-of-need, NPI, signature
  - date, and an affirmation of medical necessity.
- When the order includes a PAP device it prints a **Medicare PAP LCD
  (L33718)** supporting-documentation note (face-to-face within 6 months,
  qualifying sleep test, written-order-prior-to-delivery). This is
  accurate and useful.
- `validatePrescriptionRequestInputs()` requires NPI (10-digit), at least
  one ICD-10, a return fax, and a sane length-of-need.

Findings:

- **Hard-coded `orders@pennpaps.com` in the layout comment only** — the
  actual return email is `supplier.email`, passed in. Not a defect.
- Verdict: **Ready-with-conditions** (depends on a correctly resolved
  supplier identity for the letterhead and return fax).

### 2.5 CMN questionnaire PDF — `cmn-pdf.ts`

**Obsolescence (blocker-context, not a code defect).** CMS discontinued
Certificates of Medical Necessity (CMN) and DME Information Forms (DIF)
for claims with **dates of service on or after January 1, 2023** (CMS
**CR 12734**; see also MLN Matters **SE22002**). Claims submitted to a
DME MAC _with_ a CMN/DIF attached on/after that date are rejected and
returned. The information they carried is now expected in the medical
record / on the claim.

Implications for this generator:

- The renderer itself is well-built: it pairs the `CMN_FORMS` catalog
  question set with stored answers, renders a physician attestation +
  signature, and labels the form (CMS-484 / 846 / 848 / DIF). No content
  defect.
- **But it must never be presented to staff as a Medicare requirement.**
  The footer text "Maintain in the supplier record per CMS DMEPOS
  documentation requirements" is fine; what matters is the surrounding UI
  copy and any workflow that _blocks_ a Medicare dispense on a missing
  CMN. Verify the admin UI frames CMN generation as "for commercial
  payers that still request one," matching the (correct) wording already
  baked into the `cmn_pap` library template and the `cmn-forms` comments.
- Verdict: **Ready-with-conditions** — usable as a commercial-payer
  artifact; obsolete for Medicare.

### 2.6 CMS-1500 — `hcfa-1500-pdf.ts`

Header prints "APPROVED OMB-0938-1197 FORM 1500 (02-12)" and lays out
boxes by absolute coordinates.

Two structural facts the operator must understand:

1. **A printed facsimile is not a mailable Medicare claim.** Paper
   CMS-1500 claims to Medicare must be submitted on the official
   scannable **red-ink OCR** form; a black-and-white PDF facsimile is not
   OCR-readable and will be returned. Moreover, DMEPOS billing is
   overwhelmingly **electronic 837P** to the DME MAC; paper is a narrow
   exception. So treat this generator as a **supporting/reference
   document** (e.g. an attachment, a human-readable claim copy, a
   commercial-payer paper claim where allowed), not as the artifact you
   mail to a DME MAC.
2. **Box coverage is partial.** Present: 1, 1a, 2, 3, 4, 5, 6, 7, 11,
   11c, 17, 17b, 21, 23, 24 (A/B/D/E/F/G), 25, 28, 31, 33 (+NPI). The
   header comment claims "a fixed 33-box layout"; in practice the
   following are **not rendered**: **24J (rendering provider NPI)**, **26
   (patient account no.)**, **27 (accept assignment)**, **29 (amount
   paid)**, **30 (balance/Rsvd)**, **32 (service facility location)**, and
   24H/24I. For Medicare, **box 27 (accept assignment)** is material and
   **24J** carries the rendering NPI; their absence further confirms this
   is a reference rendering, not a submission form.

Verdict: **Ready-with-conditions** — acceptable as a reference/attachment
PDF; do not rely on it as the mailed Medicare claim. Recommend a visible
"reference copy — not for OCR submission" caption to prevent misuse.

### 2.7 Good Faith Estimate — `gfe-pdf.ts`

Governing rule: No Surprises Act, 45 CFR 149.610 (uninsured / self-pay
GFE). Required content includes patient name, **patient DOB**, a
description of the primary item/service, an itemized list of expected
charges, provider/facility name + NPI + TIN, and the required
disclaimers.

| Element                                                   | Present?                               |
| --------------------------------------------------------- | -------------------------------------- |
| Patient (recipient) name                                  | Yes                                    |
| Patient date of birth                                     | **No**                                 |
| Description of primary item/service                       | Yes (items table)                      |
| Itemized list w/ expected charges                         | Yes (desc/HCPCS/qty/unit/line + total) |
| Provider name                                             | Yes (`dmeOrganization.legalName`)      |
| Provider NPI                                              | Yes                                    |
| Provider TIN                                              | **No** (TIN not on the issuer block)   |
| Service date                                              | Optional field, rendered when present  |
| Disclaimer: estimate only / may change                    | Yes                                    |
| Disclaimer: right to dispute (general)                    | Yes                                    |
| Disclaimer: 120-day SELF-pay dispute window               | Yes                                    |
| Disclaimer: **$400-over PPDR threshold**                  | **No**                                 |
| Disclaimer: GFE is not a contract / does not require care | **No (weak)**                          |
| CMS contact (cms.gov/nosurprises, 1-800-985-3059)         | Yes                                    |

Findings:

- **Missing the $400 patient-provider dispute-resolution (PPDR)
  threshold (should-fix).** The federal PPDR process is available when
  the _billed_ charge is **at least $400 more** than the GFE for that
  provider. The current disclaimer tells the patient they "have the right
  to dispute the bill" without stating the $400 trigger; the standard
  CMS model notice includes it. Add the threshold sentence.
- **Missing patient DOB (should-fix).** 149.610 lists date of birth among
  the required patient identifiers on the GFE.
- **Provider TIN not rendered (nice-to-have).** The rule expects the
  provider TIN; only NPI is printed. Add TIN to the issuer block.
- **"GFE is not a contract" not stated explicitly (nice-to-have).** The
  model language clarifies the GFE does not obligate the patient to
  obtain the items. The current text implies but does not state it.
- The disclaimer text is **passed in by the caller** (`disclaimerText`),
  so the snapshot-at-generation design is sound — but `DEFAULT_DISCLAIMER`
  is what most callers will use, so fix it there.
- Verdict: **Ready-with-conditions.**

### 2.8 Prior-authorization request — `pa-request-pdf.ts`

There is no single federal PA form for PAP; this is a universal,
payer-addressed request for commercial / Medicare-Advantage / Medicaid-MCO
payers (Medicare FFS does not require PA for E0601/E0470/E0471). It
carries: patient + insurance IDs, ordering provider (name + NPI),
servicing supplier (NPI/TIN), requested HCPCS lines with length-of-need,
OSA diagnosis (ICD-10), **qualifying sleep study (type/date/AHI/RDI)**,
**face-to-face evaluation date**, prescribed pressure, a documentation
checklist, and an LCD L33718 qualifying-criteria reminder. Fields it
cannot auto-fill render as labelled blanks.

This is the most complete clinical-justification document in the set.
**Ready.** (Minor: the AHI/RDI criteria reminder is Medicare-LCD-derived;
commercial payers vary — fine as a reminder, not a guarantee.)

### 2.9 Appeal / redetermination — `appeal-pdf.ts`

Governing reference: Medicare redetermination (first-level appeal)
elements — beneficiary name, Medicare number / claim number, the specific
item/service and date(s) of service, and the **name and signature of the
party or representative** requesting the redetermination. (CMS form
CMS-20027 is the standard redetermination request.)

| Element                        | Present?                                       |
| ------------------------------ | ---------------------------------------------- |
| Beneficiary name               | Yes (`patientName`)                            |
| Member ID / claim number       | Yes (member ID + claim #)                      |
| Item/service & DOS             | DOS yes; specific item/service only if in body |
| Reason for appeal              | Yes (denial reason + free-text body)           |
| **Requester name + signature** | Signer name/title yes; **no signature line**   |

Findings:

- **No signature line (should-fix).** A redetermination request must be
  signed by the appellant or representative. The letter ends with a typed
  signer block ("Sincerely, / name / title / org") but draws **no
  signature line** for a wet/﻿e-signature. Add one.
- **Item/service is not a structured field.** It only appears if the
  CSR-authored `letterBody` includes it. For a redetermination the
  specific item/service is required — consider a structured line.
- The letter body is AI-assisted free text (from the denial analyzer).
  That is fine, but it means completeness depends on the operator. The
  generator cannot itself guarantee the required content.
- Verdict: **Ready-with-conditions.**

### 2.10 Patient statement — `statement-pdf.ts`

Complete for a balance statement: issuer block, patient block, per-claim
table (DOS / payer / billed / paid / you-owe), total due, optional
pay-by date + pay-online URL, and a re-bill-if-insurance-changed note.
Negative amounts render correctly (the `money()` fix). CONFIDENTIAL/PHI
banner on every page. No regulatory minimum applies beyond clear
itemization. **Ready.**

### 2.11 Patient packet — `templates.ts`

Seven templates; the required set is enforced (`REQUIRED_DOC_KEYS`) and
the API rejects a packet missing any of them.

- **Assignment of Benefits** — assigns benefits, authorizes release of
  information, acknowledges financial responsibility. Complete. **Ready.**
- **Notice of Privacy Practices (acknowledgement)** — this is an
  _acknowledgement of receipt_ plus a summary, not the full NPP. Against
  45 CFR 164.520 the summary covers: uses/disclosures for TPO, "as
  required by law," the individual rights (access, amendment, **request
  restrictions**, confidential communications, accounting, paper copy),
  and the **right to complain to HHS** without retaliation. It states a
  more detailed copy is available on request.
  - **Gaps vs. 164.520 (should-fix):** the summary does **not** mention
    the **right to be notified of a breach** of unsecured PHI, does not
    carry an **effective date**, and does not give a **named privacy
    contact** (it points complaints at the general `c.phone`). These are
    required elements of a compliant NPP. Because the on-screen text is
    framed as a _summary with the full NPP available on request_, the
    enforceable fix is to ensure the **full NPP** the supplier furnishes
    on request contains all 164.520 elements (breach notification,
    effective date, privacy-officer contact). Recommend adding those
    three to the summary as well.
- **Patient Rights & Responsibilities** — complete; includes grievance
  path. **Ready.**
- **Financial Responsibility** — deductible/coinsurance/non-covered,
  rental/capped-rental, statement terms, optional card-on-file (PCI
  language). **Ready.**
- **Medicare DMEPOS Supplier Standards** — uses the **abbreviated** list,
  which is expressly permitted (71 FR 48354), and states "The full text
  is available on request or from your Medicare contractor." Correct.
  **Ready.** (The selected standards paraphrase 424.57(c); the
  abbreviated-list safe harbor covers this.)
- **Consent to Care** — voluntary consent, coordination-of-care
  authorization, communications consent (phone/text/email), instruction
  acknowledgement. **Ready.**
- **Proof of Delivery** — see 2.12.

Cross-cutting packet finding: every template interpolates the
`CompanyProfile` (`c.legalName`, `c.phone`, `c.email`). If
`dme_organization` is unseeded, `resolveCompanyProfile()` returns
`FALLBACK_COMPANY` = **"PennPaps" / "(215) 555-0100"** — a placeholder
phone. A patient packet rendered in that state ships a fake phone number
on the AOB, NPP complaint line, rights/grievance line, etc. **Should-fix
(operator action):** seed the org before sending packets.

### 2.12 Proof of Delivery — packet `proof_of_delivery` + library `pod_pap`

Governing reference: Medicare Program Integrity Manual (Pub. 100-08) ch.
4 §4.26 — a direct-delivery POD must identify: beneficiary name, delivery
address, a sufficiently detailed item description (to identify HCPCS),
quantity, **delivery date**, and the **beneficiary/designee signature**
(and the signature date is the date of delivery).

| Element                               | Packet POD                        | `pod_pap` template                       |
| ------------------------------------- | --------------------------------- | ---------------------------------------- |
| Beneficiary name                      | via packet signer identity        | blank field                              |
| Delivery address                      | `deliveryDetails.deliveryAddress` | "delivered to the address shown"         |
| Item description (HCPCS-identifiable) | itemized w/ HCPCS                 | brand/model + HCPCS column               |
| Quantity                              | per item                          | qty column                               |
| Delivery date                         | captured ("date received")        | "signature date is the date of delivery" |
| Beneficiary/designee signature        | signed packet                     | signature + designee block               |

Both carry the §4.26 elements, and both correctly tie the signature date
to the delivery date and allow a designee. The packet POD splices the
itemization in via `buildDeliveryDetailSections()` so an operator edit to
the static wording cannot drop the item list. **Ready.**

### 2.13 ABN — intake `abn` and library `abn_medicare` — NOT READY

This is the most significant compliance gap.

Governing rule: the Medicare **Advance Beneficiary Notice of Noncoverage
(ABN), Form CMS-R-131**, is an **OMB-approved, standardized** notice. CMS
requires that providers use the **official form** — the layout, the
header block, the Options 1–3 wording, and the OMB control number are
prescribed. A paraphrased or home-grown ABN is **not valid**; an invalid
ABN means the supplier generally **cannot** shift financial liability to
the beneficiary for a denied item.

Current state of the ABN form version (verified 2026-06-11): CMS released
a **revised CMS-R-131 effective March 13, 2026**, with OMB approval valid
through **March 31, 2029**. Providers **must** transition to the updated
form by **May 12, 2026** (the prior version was usable until then). As of
this review (June 11, 2026) the **revised March-2026 CMS-R-131 is the
mandatory current form** — the "expires 01/31/2026" version referenced in
older guidance is superseded.

What the code does instead:

- `intake-forms/catalog.ts` → `abn`: a two-sentence paraphrase
  ("Medicare may not pay for items it determines are not reasonable and
  necessary..."). **Not the CMS-R-131.**
- `manual-documents/standard-documents.ts` → `abn_medicare`: a much more
  faithful reproduction — it reproduces the Options 1/2/3 wording and the
  issue-before-delivery rules, and the `description`/`body` correctly
  state the form must be issued and signed _before_ delivery and that an
  ABN signed after delivery is invalid. **But it is still a hand-built
  reproduction, not the official OMB-approved form** (no OMB control
  number block, not the official layout, wording will drift from the
  March-2026 revision).

**Finding (blocker):** neither ABN is the official CMS-R-131. For any
Medicare ABN, replace these with the **current official CMS-R-131 (March
2026 revision)** — render/serve the actual OMB-approved form (fill the
official PDF's fields) rather than generating bespoke text. Keep the
helpful operator guidance (issue before delivery, beneficiary picks one
option, keep a copy) as surrounding instructions, but the document the
beneficiary signs must be the official form. Until then, the ABN should
be flagged in-app as "not for Medicare use."

Verdict: **Not-ready.**

### 2.14 Intake forms catalog — other entries (`intake-forms/catalog.ts`)

`hipaa_npp`, `aob`, `financial_responsibility`, `supplier_standards` are
short acknowledgement bodies. Two cross-cutting issues:

- **Hard-coded "PennPaps" (should-fix).** Every body string literally
  says "PennPaps" rather than interpolating the resolved org legal name.
  Unlike the packet templates, these are not parameterised by a company
  profile. If the legal entity name differs from "PennPaps," these are
  wrong, and they cannot be corrected by seeding `dme_organization`.
- **Thin NPP body (nice-to-have).** The `hipaa_npp` body is one sentence;
  the same 164.520 gaps as 2.11 apply but more so. These appear to be
  acknowledgement stubs; if they are patient-facing, expand or replace
  with the packet templates, which are richer and parameterised.

Verdict: **Ready-with-conditions** (informational acknowledgements only;
fix the hard-coded name).

### 2.15 Signature log / e-signature certificate (`signature-log-pdf.ts`)

Produces an auditor-facing attestation that a provider's typed
e-signature is their legal signature, citing the **federal ESIGN Act (15
U.S.C. ch. 96)** and CMS electronic-signature requirements, plus a
tamper-evident hash-chain integrity verdict, signer NPI, IP, timestamp,
and ESIGN consent flag. This is well-constructed and appropriate for a
records-request response. **Ready.** (UETA is the state-law analog; the
ESIGN citation is sufficient.)

---

## 3. What "Medicare approved" actually means

The business owner's framing — "verify they are Medicare and other payor
approved and ready to be sent" — needs an important correction, because
it changes what "done" looks like:

1. **No payer pre-approves a supplier's generated paperwork.** Medicare
   (and commercial payers) do not review and bless a supplier's SWO,
   prescription request, statement, GFE, or packet. There is no
   submission queue for "approve my document template." Instead, these
   documents are judged **at audit / claim-review time** against published
   **content requirements** (the regs cited throughout this review). So
   "ready to send" = "carries every required content element and uses the
   official layout where one is mandated," not "stamped approved."

2. **A small number of documents have a federally controlled layout and
   MUST be the official version:**
   - **ABN — Form CMS-R-131.** OMB-approved; you must use the official
     form (current = March 2026 revision, mandatory since May 12, 2026).
     The two home-grown ABNs in this codebase do not satisfy this. **This
     is the one true blocker in the set.**
   - **CMS-1500 (02/12)** for _mailed_ paper claims must be the scannable
     **red-OCR** form. A PDF facsimile is a reference copy only.
   - (Some payers also mandate their own PA portal forms; the universal
     PA request here is a content-complete fallback, not a substitute for
     a payer that requires its own form.)

3. **CMNs and DIFs are discontinued for Medicare** (CR 12734 / SE22002,
   dates of service on/after 2023-01-01). Generating one is not "more
   compliant"; for a Medicare claim it is at best unnecessary and at worst
   causes a claim to be returned. Keep CMN generation only for commercial
   payers that still ask for it, and never gate a Medicare dispense on it.

4. **Everything else is content-judged.** SWO (410.38(d)), POD (PIM ch. 4
   §4.26), supplier standards (424.57(c), abbreviated per 71 FR 48354),
   GFE (45 CFR 149.610), NPP (45 CFR 164.520), redetermination
   (CMS-20027 elements). This review checks those element-by-element
   above.

Recommended operator actions before relying on any of these in
production:

- **Seed `dme_organization`** (**/admin/company-information**) with the real
  legal name, NPI, TIN, address, phone, and billing email. Until then,
  documents print `FALLBACK_COMPANY` ("PennPaps" / "(215) 555-0100") and
  the billing identity falls back to env/stub values — placeholder data
  on real patient- and payer-facing paper. Confirm the resolver reports
  `source: "db"` (it logs a `billing_identity_stub` warning otherwise).
- **Replace both ABNs with the official CMS-R-131** (March 2026 revision)
  and gate ABN issuance behind the official form.
- **Have the DME MAC jurisdiction's supplier manual and the supplier's
  accreditation consultant (ACHC/the AO) review the packet and the GFE**
  — particularly the NPP (164.520 breach-notification, effective date,
  privacy contact) and the GFE PPDR/$400 language — before first use.
  This is a content review only; final sign-off on patient-facing forms
  is a business/accreditation decision, not an engineering one.

---

## 4. Action checklist

### Blockers (fix before sending to Medicare beneficiaries)

- [ ] **Replace the home-grown ABN** in both `intake-forms/catalog.ts`
      (`abn`) and `manual-documents/standard-documents.ts` (`abn_medicare`)
      with the **official CMS-R-131 (March 2026 revision)**. Until then,
      flag the ABN in-app as "not valid for Medicare." (§2.13)

### Should-fix (content gaps against the governing reg)

- [ ] **Seed `dme_organization`** so no document ships
      `FALLBACK_COMPANY`/stub identity. Operator action; verify
      `resolveBillingIdentity` returns `source:"db"`. (§2.11, §2.15-ident)
- [x] **GFE disclaimer:** the **$400 PPDR threshold** sentence and the
      "not a contract" statement are now in `DEFAULT_DISCLAIMER` (fixed
      in this change-set). Still open: add the **patient DOB** and the
      issuer **TIN** to `GfeInput` and the issuer block. (§2.7)
- [x] **Appeal/redetermination:** a **requester signature/date line** is
      now drawn above the typed signer block (fixed in this change-set).
      Still open: a structured **item/service** field; don't depend
      solely on the free-text body. (§2.9)
- [ ] **NPP:** ensure the full Notice of Privacy Practices (and ideally
      the summary) includes **breach-notification right**, an **effective
      date**, and a **named privacy contact**. (§2.11, §2.14)
- [x] **Intake catalog:** the serve-time route now rewrites the bodies
      with the admin-saved company identity
      (`applyCompanyIdentityToText`, fixed in this change-set), so the
      hard-coded "PennPaps" only appears while `dme_organization` is
      unseeded. (§2.14)
- [ ] **SWO quantity:** render an explicit per-item **quantity** when the
      order covers supplies (or steer supply orders to the `swo_pap`
      template that already does). (§2.1, §2.3)

### Nice-to-have / clarity

- [ ] **CMS-1500:** add a visible "reference copy — not for OCR
      submission to Medicare" caption; optionally render boxes 26/27/32/24J
      if the facsimile will ever be used for a commercial paper claim.
      (§2.6)
- [ ] **CMN UI framing:** confirm the admin UI presents CMN generation as
      "commercial payers that still request one," never as a Medicare
      requirement, and never gates a Medicare dispense on a CMN. (§2.5)
- [ ] **PA request:** note that the LCD AHI/RDI reminder is
      Medicare-derived and commercial criteria vary. (§2.8)

---

## References (verified 2026-06-11)

- CMS, "CMS Discontinuing the Use of Certificates of Medical Necessity
  and Durable Medical Equipment Information Forms" — CR 12734 / MLN
  Matters SE22002 (CMNs & DIFs eliminated for DOS on/after Jan 1, 2023).
- CMS Beneficiary Notices Initiative — Form **CMS-R-131 (ABN)** revised
  **effective March 13, 2026**, OMB approval through **March 31, 2029**,
  mandatory use by **May 12, 2026**.
- 42 CFR 410.38(d) — Standard Written Order elements.
- 42 CFR 424.57(c) and 71 FR 48354 — DMEPOS supplier standards
  (abbreviated-notice safe harbor).
- 45 CFR 149.610 — No Surprises Act Good Faith Estimate for
  uninsured/self-pay; $400 PPDR dispute threshold.
- 45 CFR 164.520 — Notice of Privacy Practices required content.
- Medicare Program Integrity Manual (Pub. 100-08) ch. 4 §4.26 — Proof of
  Delivery elements.
- CMS LCD L33718 / Policy Article A52467 — PAP coverage criteria.
- Federal ESIGN Act, 15 U.S.C. ch. 96 — electronic signatures.

This review reflects the code state at the time of writing and publicly
available CMS guidance as of 2026-06-11. It is not legal advice; confirm
form versions and content with the supplier's DME MAC and accreditation
organization before production use.
