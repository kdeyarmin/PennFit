# Inbound-fax barcode auto-filing

When PennFit sends a document out for a provider signature — a
prescription request or a signable manual document — it stamps the PDF
with a short **signature-tracking code** (`PFS-XXXXXXXX`), printed both as
a Code 128 barcode and as human-readable text in the top-right corner
(`artifacts/resupply-api/src/lib/barcode/tracking-stamp.ts`). The code is
minted and tracked in `resupply.signature_tracking` (migration 0254).

This feature closes the loop: when the **signed copy is faxed back**, the
inbound-fax ingest can read that code off the page and file the document
automatically — no CSR triage required.

## Flow

Telnyx delivers the fax → `POST /fax/inbound` →
`ingestInboundFax()` mirrors the bytes to private object storage. Then,
**only when the `fax.auto_file_signed` feature flag is ON**:

1. **Scan** — `lib/inbound-fax/tracking-scan.ts` reads the page for the
   `PFS-XXXXXXXX` code via the existing BAA-covered Claude vision path
   (the same path the on-demand fax OCR uses). It asks the model for _only_
   the opaque code — never patient text — and validates the shape before
   trusting it.
2. **Match** — the code is looked up in `signature_tracking`. The fax is
   auto-filed only on an exact match to an **outstanding**
   (`awaiting_signature`) row that carries a patient.
3. **File to chart** — the fax bytes are copied into a new private object
   and a `patient_documents` row is created (retention-stamped, marked
   reviewed — a verified barcode match needs no human acknowledgement).
4. **Mark returned** — `markReturnedAndCascade()` flips the signature to
   `returned_signed` and advances the source prescription packet to
   `signed`.
5. **Release the bill hold** — any outstanding
   `claim_paperwork_requirements` row sourced from that document is
   satisfied (`satisfyRequirement(via: "inbound_fax")`), which recomputes
   the claim's `bill_hold`.
6. **Record** — the `inbound_faxes` row is attached to the patient and
   stamped with the outcome (`auto_file_status`, `tracking_code_detected`,
   `signature_tracking_id`, `chart_document_id`, `auto_filed_at`).

The orchestration lives in `lib/fax/auto-file-signed.ts`. It **never
throws**: any failure leaves the fax in the triage queue exactly as
before, with `auto_file_status` recording why.

## Outcomes (`inbound_faxes.auto_file_status`)

| Status             | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `filed`            | Matched, filed to chart, marked returned & signed (success).                            |
| `no_code`          | Scanned, but no PennFit code on the page.                                               |
| `no_match`         | A code was read but no `signature_tracking` row matches it.                             |
| `already_returned` | Matched a row that was already returned/canceled (no-op).                               |
| `no_patient`       | Matched an outstanding row with no patient — marked returned, but not filed to a chart. |
| `failed`           | The scan or the chart write errored.                                                    |
| `unsupported`      | Media type can't be scanned (e.g. a TIFF fax).                                          |
| `offline`          | No AI key configured; nothing scanned.                                                  |

The CSR inbox (`/admin/inbound-faxes`) shows an **Auto-filed** badge on
matched rows and a banner in the triage modal explaining the outcome.

## Posture

- **Opt-in, seeded OFF** (`fax.auto_file_signed`, migration 0256) — filing
  a clinical document and marking it signed is consequential, so it
  mirrors the `email.auto_reply` opt-in. With the flag off, faxes are
  triaged by hand exactly as before and the new columns stay `NULL`. Flip
  it on from the admin feature-flags screen when ready.
- **Fail-soft** — degrades to manual triage whenever no AI key is set, the
  scan finds no code, or anything errors.
- **Two complementary auto-matches.** The barcode match (precise,
  per-document) runs first; the older fax-number match
  (`autoMatchInboundFaxToPaperwork`, by `expected_return_fax_e164`) still
  runs after it for non-barcoded returns and is a no-op once the barcode
  step has satisfied the requirement.
- **PHI** — the fax bytes and chart document live under their own
  object-storage ACL; logs and audit rows carry only the opaque tracking
  code + ids, never patient text or image bytes.

## Why vision, not a barcode decoder

Received faxes are low-resolution raster (~200 dpi), where decoding a
Code 128 barcode is unreliable — which is exactly why the stamp also
prints the code as plain text beside the bars. Reading that text with the
already-wired Claude vision path is robust and adds no new dependency or
vendor. A deterministic decoder could be slotted in front of the vision
scan later without changing the rest of the flow.
