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

1. **Read the code** — a deterministic Code 128 decode
   (`lib/inbound-fax/barcode-decode.ts`) runs first (free, instant, no model
   cost). On a miss it falls back to the BAA-covered Claude vision scan
   (`lib/inbound-fax/tracking-scan.ts`), which asks the model for _only_ the
   opaque `PFS-XXXXXXXX` code — never patient text. Either reader's result is
   validated (`isWellFormedTrackingCode`) before it's trusted.
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

- **Opt-in, seeded OFF** (`fax.auto_file_signed`, migration 0258) — filing
  a clinical document and marking it signed is consequential, so it
  mirrors the `email.auto_reply` opt-in. With the flag off, faxes are
  triaged by hand exactly as before and the new columns stay `NULL`. Flip
  it on from the admin feature-flags screen when ready.
- **Fail-soft** — degrades to manual triage whenever no AI key is set, the
  scan finds no code, or anything errors.
- **Two complementary auto-matches.** The barcode match (precise,
  per-document) runs first. The older fax-number match
  (`autoMatchInboundFaxToPaperwork`, by `expected_return_fax_e164`) runs
  only as a fallback and is **skipped entirely when the barcode step already
  filed the fax** — otherwise it could auto-satisfy an unrelated
  same-fax-number requirement with a fax the barcode already matched.
- **PHI** — the fax bytes and chart document live under their own
  object-storage ACL; logs and audit rows carry only the opaque tracking
  code + ids, never patient text or image bytes.

## Reading the code: deterministic decode, then vision

Two readers run in front of each other, both validated against
`isWellFormedTrackingCode`:

1. **Deterministic Code 128 decode** — free, instant, no model cost.
   `lib/barcode/code128-decode.ts` is the inverse of the encoder (shares its
   symbol tables so the two can't drift; validates the mod-103 checksum +
   Start/Stop framing, so a misread returns null, never a wrong code).
   `lib/inbound-fax/barcode-decode.ts` rasterizes the fax and scans rows
   (`scanGrayscaleForCode`):
   - **PDF** (Telnyx's default) → rasterized with the WASM **PDFium** build
     (`@hyzyla/pdfium`, MIT, no native compile) at ~288 dpi, grayscale.
   - **Raster faxes** (TIFF / image) → rasterized with `sharp` when present,
     imported _optionally_ (a soft dependency: null when not installed).
   - Both rasterizers load lazily + memoized and are fail-soft.
2. **Vision scan** — `lib/inbound-fax/tracking-scan.ts`, the robust fallback
   (BAA-covered Claude). It reads the human-readable code printed beside the
   bars — which survives the degraded scans where 1D decoding fails.

The deterministic path reliably handles **crisp bars** — it round-trips the
encoder's own output, verified end-to-end through a real PDFium render of a
stamped PDF (`barcode-decode.pdf.test.ts`). Heavily degraded ~200 dpi fax
scans that don't decode simply fall through to the vision scan, so coverage
is "free when it's readable, vision otherwise." Neither reader can produce a
wrong code: both validate the shape, and the lookup must match an
outstanding signature before anything is filed.

## Enabling & validating (operator)

The feature ships **OFF**. To turn it on safely:

1. **Deploy the migration.** On the next deploy the migrator applies
   `0296_inbound_fax_auto_file.sql` (adds the `inbound_faxes` columns + seeds
   the flag OFF). Confirm:
   `select key, enabled from resupply.feature_flags where key = 'fax.auto_file_signed';`
   → one row, `enabled = false`.
2. **Confirm the AI key.** The vision fallback needs `ANTHROPIC_API_KEY`
   (already set per the AI stack). Without it the scan is `offline` and every
   fax falls to manual triage — safe, just inert.
3. **Flip the flag on** in Admin → Feature flags → `fax.auto_file_signed`.
   Takes effect within ~5s (the flag is process-cached).
4. **Validate one real round-trip:**
   - Create + **fax** a prescription request for a test patient; note the
     `PFS-XXXXXXXX` printed top-right.
   - **Sign and fax it back** to the PennFit fax number.
   - Within a minute, open **`/admin/inbound-faxes`** → the fax shows an
     **Auto-filed** badge; the triage modal banner reads "Auto-filed to the
     patient chart…".
   - Confirm the downstream effects: **`/admin/signature-tracking`** shows
     the item as **Returned signed**; the patient chart has a new
     **Prescription** document; and if it gated a claim,
     **`/admin/billing/bill-hold-worklist`** shows the hold released.
5. **Watch the outcomes.** Faxes that did not auto-file record why in
   `inbound_faxes.auto_file_status` (see the table above) and stay in the
   triage queue — nothing is lost. A run of `no_code` on faxes you expected
   to match usually means the printed code was unreadable; re-fax at higher
   quality or file by hand with the signature-tracking **lookup** box (still
   available).

**Rolling back** is just flipping the flag OFF: faxes already auto-filed
stay filed, and new faxes return to manual triage.
