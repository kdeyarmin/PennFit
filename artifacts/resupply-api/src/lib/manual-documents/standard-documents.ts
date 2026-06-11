// Standard payer-document library.
//
// Code-defined, payer-compliant starting points for the documents a
// DMEPOS supplier sends most: the Medicare Standard Written Order, a
// PAP CMN, an ABN, an Assignment of Benefits, the abbreviated DMEPOS
// Supplier Standards notice, a proof-of-delivery ticket, and a refill /
// continued-use confirmation. Because the library lives in code (not in
// a table), it is ALWAYS visible to every staff member with
// `patients.read` and can never be deleted or hidden — using a template
// simply creates an ordinary editable manual_documents draft via the
// existing POST /admin/manual-documents.
//
// Content posture: templates carry STANDARD WORDING ONLY. Every
// patient-identifying field (name, DOB, address, …) is left blank so a
// template contains no PHI and the existing "Prefill from chart" /
// blanks-only merge keeps working on a draft created from one.
//
// Compliance notes baked into the wording:
//   * SWO — the six required elements of 42 CFR 410.38 (beneficiary,
//     order date, item description, quantity, treating practitioner
//     name/NPI, practitioner signature).
//   * PAP CMN — coverage criteria template per NCD 240.4 / the PAP
//     LCD (AHI/RDI thresholds, face-to-face evaluation, 90-day
//     adherence for continued coverage). CMS retired its own CMN forms
//     effective 2023-01-01; this template is for commercial payers
//     that still request one.
//   * ABN — the CMS-R-131 option structure (Options 1–3) and the
//     delivery rules (issue BEFORE the item, beneficiary picks one
//     option, keep a copy).
//   * Supplier standards — the abbreviated text permitted by
//     42 CFR 424.57(c).
//   * Proof of delivery — the elements the Medicare Program Integrity
//     Manual requires for direct delivery (items, quantity, address,
//     date, beneficiary/designee signature; signature date = delivery
//     date).
//   * Refill confirmation — the no-sooner-than-14-days contact rule
//     and the remaining-quantity documentation requirement for
//     recurring supplies.
//
// Pure module — no I/O, no DB, no PHI. Mirror of catalog.ts.

import { manualDocumentFieldKeys, type ManualDocumentType } from "./catalog.js";

export interface StandardDocumentTemplate {
  /** Stable identifier (used by the SPA; never persisted). */
  key: string;
  /** Display name in the library list. */
  label: string;
  /** Which manual-document type a draft created from this template uses. */
  documentType: ManualDocumentType;
  /** One-line "when to use this" shown in the library list. */
  description: string;
  /** Title the created draft starts with (editable). */
  title: string;
  /** Prefilled type-catalog fields — standard wording only, no PHI. */
  fields: Readonly<Record<string, string>>;
  /** Prefilled free-form body — standard wording only, no PHI. */
  body: string;
}

export const STANDARD_DOCUMENT_LIBRARY: readonly StandardDocumentTemplate[] = [
  {
    key: "swo_pap",
    label: "Standard Written Order (SWO) — PAP device & supplies",
    documentType: "prescription",
    description:
      "Medicare-compliant written order for a PAP device and resupply items, with the 42 CFR 410.38 required elements and standard HCPCS quantities prefilled.",
    title: "Standard Written Order — PAP Device & Supplies",
    fields: {
      items_ordered: [
        "E0601 — Continuous positive airway pressure (CPAP) device — qty 1",
        "A7030 — Full face mask used with PAP device — qty 1 per 3 months",
        "A7031 — Full face mask cushion/seal replacement — qty 1 per month",
        "A7034 — Nasal interface (mask) used with PAP device — qty 1 per 3 months",
        "A7032 — Nasal mask cushion replacement — qty 2 per month",
        "A7033 — Nasal pillows replacement — qty 2 per month",
        "A7035 — Headgear used with PAP device — qty 1 per 6 months",
        "A7036 — Chinstrap used with PAP device — qty 1 per 6 months",
        "A7037 — Tubing used with PAP device — qty 1 per 3 months",
        "A7038 — Disposable filter used with PAP device — qty 2 per month",
        "A7039 — Non-disposable filter used with PAP device — qty 1 per 6 months",
        "A7046 — Humidifier water chamber, replacement — qty 1 per 6 months",
        "E0562 — Heated humidifier used with PAP device — qty 1",
        "",
        "(Strike any items not ordered; adjust quantities as prescribed.)",
      ].join("\n"),
      directions:
        "Use PAP device nightly during all sleep at the pressure setting determined by titration or auto-titrating range. Replace supplies per the quantities listed, as needed for hygiene and effective therapy.",
      length_of_need: "99 (lifetime medical need)",
    },
    body: [
      "This order must contain all elements required for a Standard Written Order under 42 CFR 410.38 before items are dispensed or a claim is submitted:",
      "  1. Beneficiary name or Medicare Beneficiary Identifier (MBI)",
      "  2. Order date",
      "  3. General description of the item(s) — description, HCPCS code, or brand name/model",
      "  4. Quantity to be dispensed, if applicable",
      "  5. Treating practitioner name or NPI",
      "  6. Treating practitioner signature",
      "",
      "Complete the blank patient and prescriber fields above (or use “Prefill from chart”), then send for the treating practitioner's signature. Keep the signed order on file before delivery.",
    ].join("\n"),
  },
  {
    key: "cmn_pap",
    label: "Certificate of Medical Necessity — PAP therapy",
    documentType: "cmn",
    description:
      "Medical-necessity certification for CPAP/BiPAP with the Medicare PAP coverage criteria (NCD 240.4 / PAP LCD) as an editable justification template. For payers that still request a CMN — CMS retired its own CMN forms effective Jan 1, 2023.",
    title: "Certificate of Medical Necessity — PAP Therapy",
    fields: {
      diagnosis:
        "G47.33 — Obstructive sleep apnea (adult). (Add or replace ICD-10 codes as documented.)",
      equipment: [
        "E0601 — CPAP device, with heated humidifier (E0562) and related supplies",
        "(Replace with E0470/E0471 bi-level codes if a bi-level device is ordered.)",
      ].join("\n"),
      length_of_need: "99 (lifetime medical need)",
      clinical_justification: [
        "The patient had a face-to-face clinical evaluation prior to the sleep test documenting signs and symptoms of obstructive sleep apnea.",
        "",
        "A Medicare-covered sleep test (in-laboratory polysomnogram or home sleep apnea test) established a diagnosis of obstructive sleep apnea with:",
        "  [ ] AHI or RDI ≥ 15 events per hour; or",
        "  [ ] AHI or RDI ≥ 5 and ≤ 14 events per hour WITH documented excessive daytime sleepiness, impaired cognition, mood disorder, insomnia, hypertension, ischemic heart disease, or history of stroke.",
        "",
        "Sleep study date: ______________   AHI/RDI: ______________",
        "",
        "PAP therapy is medically necessary to treat the patient's obstructive sleep apnea. For continued Medicare coverage beyond the first 90 days, adherence (use ≥ 4 hours per night on 70% of nights during a consecutive 30-day period) and clinical benefit will be documented at a face-to-face re-evaluation.",
      ].join("\n"),
    },
    body: "Complete the blank patient and physician fields (or use “Prefill from chart”), check the applicable coverage criterion, fill in the study date and AHI/RDI, and obtain the physician's signature. Keep the supporting sleep study and clinical notes on file.",
  },
  {
    key: "abn_medicare",
    label: "Advance Beneficiary Notice of Non-coverage (ABN)",
    documentType: "agreement",
    description:
      "Notice to a Medicare beneficiary that an item may not be covered, with the CMS-R-131 option structure. Must be issued and signed BEFORE delivery. IMPORTANT: this template mirrors the option structure but is NOT the official OMB-approved CMS-R-131 form — for Medicare liability-shifting you must use the current official CMS-R-131 from cms.gov (March 2026 revision); use this template only as staff reference or for non-Medicare payers.",
    title: "Advance Beneficiary Notice of Non-coverage (ABN)",
    fields: {
      agreement_type:
        "Advance Beneficiary Notice of Non-coverage (CMS-R-131 structure)",
      terms: [
        "NOTE: Medicare may not pay for the item(s) listed below. Medicare does not pay for everything, even some care that you or your health care provider have good reason to think you need.",
        "",
        "Item(s) / service(s): ____________________________________________",
        "Reason Medicare may not pay: _____________________________________",
        "Estimated cost: $________",
        "",
        "WHAT YOU NEED TO DO NOW: Read this notice so you can make an informed decision about your care. Ask us any questions. Choose ONE option below. We cannot choose an option for you.",
        "",
        "[ ] OPTION 1. I want the item(s) listed above. I want Medicare billed for an official decision on payment, which is sent to me on a Medicare Summary Notice (MSN). I understand that if Medicare doesn't pay, I am responsible for payment, but I can appeal to Medicare by following the directions on the MSN.",
        "",
        "[ ] OPTION 2. I want the item(s) listed above, but do not bill Medicare. I am responsible for payment and cannot appeal because Medicare is not billed.",
        "",
        "[ ] OPTION 3. I don't want the item(s) listed above. I understand I am not responsible for payment, and I cannot appeal to see if Medicare would pay.",
        "",
        "Additional information: __________________________________________",
        "",
        "Signing below means that you have received and understand this notice. You also receive a copy.",
      ].join("\n"),
    },
    body: "Issue this notice BEFORE delivering the item. The beneficiary (or their representative) must personally select ONE option, sign, and date. Give the beneficiary a copy and keep the signed original on file. An ABN signed after delivery is not valid.",
  },
  {
    key: "aob_financial",
    label: "Assignment of Benefits & Financial Responsibility",
    documentType: "agreement",
    description:
      "Authorizes the supplier to bill Medicare / the patient's insurer directly, release records for claims, and confirms the patient's responsibility for deductibles, coinsurance, and non-covered amounts.",
    title: "Assignment of Benefits & Financial Responsibility Agreement",
    fields: {
      agreement_type: "Assignment of Benefits & Financial Responsibility",
      terms: [
        "1. ASSIGNMENT OF BENEFITS. I request that payment of authorized Medicare and/or other insurance benefits be made on my behalf directly to the supplier for any equipment, supplies, or services furnished to me by the supplier.",
        "",
        "2. RELEASE OF INFORMATION. I authorize the supplier to release any medical or other information needed to determine these benefits or the benefits payable for related services to the Centers for Medicare & Medicaid Services (CMS), its agents and contractors, and/or my other insurer(s).",
        "",
        "3. FINANCIAL RESPONSIBILITY. I understand that I am financially responsible for any deductible, coinsurance, copayment, or non-covered item or service, to the extent permitted by law and my payer agreements. If my insurer denies payment for a reason within my control (for example, inaccurate insurance information that I provided), I agree to pay for the items or services received.",
        "",
        "4. ACCURACY OF INFORMATION. I certify that the insurance and demographic information I have provided is complete and accurate, and I agree to notify the supplier promptly of any changes.",
        "",
        "5. TERM. This agreement applies to all items and services furnished to me by the supplier from the effective date below until I revoke it in writing.",
      ].join("\n"),
    },
    body: "Have the patient (or their authorized representative) sign and date. Keep the signed agreement in the patient's chart; it covers ongoing resupply under the same payer unless revoked or the payer changes.",
  },
  {
    key: "supplier_standards",
    label: "Medicare DMEPOS Supplier Standards (abbreviated notice)",
    documentType: "other",
    description:
      "The abbreviated supplier-standards disclosure that 42 CFR 424.57(c) requires a DMEPOS supplier to furnish to each Medicare beneficiary.",
    title: "Medicare DMEPOS Supplier Standards — Beneficiary Notice",
    fields: {},
    body: [
      "The products and/or services provided to you by this supplier are subject to the supplier standards contained in the Federal regulations shown at 42 CFR Section 424.57(c). These standards concern business professional and operational matters (e.g., honoring warranties and hours of operation). The full text of these standards can be obtained at https://www.ecfr.gov. Upon request, we will furnish you a written copy of the standards.",
      "",
      "We are also happy to answer any questions about these standards, your warranty rights, or the equipment and supplies you receive. Please contact us during normal business hours.",
    ].join("\n"),
  },
  {
    key: "pod_pap",
    label: "Proof of Delivery — PAP equipment & supplies",
    documentType: "delivery_ticket",
    description:
      "Delivery ticket with the proof-of-delivery elements Medicare requires for direct delivery (items, quantities, address, date, beneficiary signature — the signature date is the date of delivery).",
    title: "Proof of Delivery — PAP Equipment & Supplies",
    fields: {
      items_delivered: [
        "Item (brand/model + HCPCS)                       Qty",
        "______________________________________________   ____",
        "______________________________________________   ____",
        "______________________________________________   ____",
        "______________________________________________   ____",
        "",
        "(List each item with a description detailed enough to identify it — brand name, model, and HCPCS code — and the quantity delivered.)",
      ].join("\n"),
    },
    body: [
      "BENEFICIARY ACKNOWLEDGMENT: I acknowledge receipt of the items listed above, delivered to the address shown, in good condition and in the quantities listed. I received instruction on the use, care, and maintenance of this equipment, and information on warranty coverage and how to reach the supplier with questions or problems.",
      "",
      "The signature below must be that of the beneficiary or their designee, and the date of signature is the date of delivery. If a designee signs, print the designee's name and relationship to the beneficiary:",
      "",
      "Designee name / relationship: _____________________________________",
      "",
      "Keep the signed delivery ticket on file — it is the proof-of-delivery record for these items.",
    ].join("\n"),
  },
  {
    key: "refill_continued_use",
    label: "Resupply Refill Request & Continued Use Confirmation",
    documentType: "agreement",
    description:
      "Documents the beneficiary-initiated refill contact Medicare requires for recurring supplies — contact no sooner than 14 days before delivery, remaining quantities on hand, and continued use of the device.",
    title: "Resupply Refill Request & Continued Use Confirmation",
    fields: {
      agreement_type: "Refill Request & Continued Use Confirmation",
      terms: [
        "Date of contact: ______________   Contact method: [ ] phone  [ ] in person  [ ] secure message/portal",
        "",
        "1. CONTINUED USE. I confirm that I am still using my PAP device and that I continue to need the supplies requested below.",
        "",
        "2. SUPPLIES REQUESTED AND QUANTITY REMAINING. For each supply requested, the quantity I have remaining is listed; my supplies are nearly exhausted (approximately a 10-day supply or less remains, or will remain by the expected delivery date):",
        "",
        "   Supply item (HCPCS)                    Qty requested    Qty remaining",
        "   ____________________________________   _____________    _____________",
        "   ____________________________________   _____________    _____________",
        "   ____________________________________   _____________    _____________",
        "",
        "3. TIMING. I understand this refill contact occurred no sooner than 14 calendar days before the expected delivery or shipping date, and that items are not dispensed automatically — this refill was requested by me (or my caregiver/designee).",
      ].join("\n"),
    },
    body: "Complete one of these for each refill cycle (a phone-call record entered by staff is acceptable — note the staff member, date, and method). Keep it on file with the delivery record to support the resupply claim.",
  },
] as const;

const LIBRARY_BY_KEY = new Map<string, StandardDocumentTemplate>(
  STANDARD_DOCUMENT_LIBRARY.map((t) => [t.key, t]),
);

export function getStandardDocumentTemplate(
  key: string,
): StandardDocumentTemplate | null {
  return LIBRARY_BY_KEY.get(key) ?? null;
}

// ── Module-load assertion ──────────────────────────────────────────
// Every template's prefilled field keys must exist in its type's
// catalog def — otherwise normalizeManualDocumentFields would silently
// drop the wording on create. Fail at boot/test time, not in the UI.
for (const template of STANDARD_DOCUMENT_LIBRARY) {
  const allowed = manualDocumentFieldKeys(template.documentType);
  for (const key of Object.keys(template.fields)) {
    if (!allowed.has(key)) {
      throw new Error(
        `standard-documents: template "${template.key}" prefills unknown field "${key}" for type "${template.documentType}"`,
      );
    }
  }
}
