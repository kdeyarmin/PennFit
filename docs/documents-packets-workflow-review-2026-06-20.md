# Documents & Packets Workflow Review — 2026-06-20

Scope: an end-to-end review of how PennFit (CareMetric Breathe) produces,
sends, e-signs, returns, files, tracks, and re-sends patient and provider
paperwork. The brief was to confirm the documents are **appropriate**,
**sent appropriately and timely**, carry **good safeguards**, and that
everything needed for e-signing is **returned, filed in the patient's
chart, tracked when not returned, and re-sendable** — i.e. that the whole
workflow works.

This is an engineering review of the live code paths (verified against
source, not docs), paired with the small set of fixes shipped in the same
change-set. It is **not** legal advice or an accreditation audit. The
document _content_ compliance review is its companion piece,
[`document-production-readiness-review-2026-06-11.md`](./document-production-readiness-review-2026-06-11.md);
this review focuses on the **workflow** around those documents.

---

## 1. Executive verdict

**The workflow is sound and, in most places, genuinely well-engineered.**
All 6,168 tests in the API package pass; the e-sign, return, chart-filing,
tracking, and re-send paths are complete, atomic where they need to be,
PHI-safe in their logging, and degrade gracefully when a vendor (SendGrid,
Twilio, Telnyx, the AI key, object storage) is unconfigured.

Two themes accounted for every real gap found:

1. **Timeliness was gated behind opt-in flags that shipped OFF.** Out of
   the box nothing auto-sent paperwork on delivery and nothing chased an
   unsigned packet. This change-set flips both to ON by default (see §6).
2. **Operator _visibility_ into outstanding patient packets was thin**
   compared to the provider-side queue. The packet list showed newest
   first, capped at 100, with no nudge/aging signal — so "who hasn't
   returned paperwork, and have we chased them?" was hard to answer at a
   glance. This change-set adds an Outstanding worklist and surfaces the
   reminder/aging state (see §6).

The one true _content_ compliance blocker — the ABN is a home-grown
paraphrase, not the official CMS-R-131 — is unchanged in substance (it
requires the official OMB form, which is an operator/business action, not
an engineering one), but this change-set adds an in-app operator warning
so the ABN can never be mistaken for a Medicare-valid notice (see §6).

---

## 2. The two signing tracks

The domain has **two independent e-signature tracks**, each complete:

| Track               | Who signs                       | Surface                                    | Auth                               | Audit                                                      |
| ------------------- | ------------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------------------------------------- |
| **Patient packets** | the patient (or representative) | public link `/patient-packet-sign?token=…` | HMAC-signed token                  | `patient_packet_signatures` row + `patient_packet.*` audit |
| **Provider e-sign** | ordering physician / NP         | MFA-gated portal `/provider/*`             | in-house auth + mandatory TOTP MFA | hash-chained `provider_signature_events`                   |

Patient packets are the new-patient consent bundle (AOB, NPP, financial
responsibility, supplier standards, consent to care, proof of delivery,
plus optional choice documents like the ABN). Provider e-sign covers
orders, prescriptions, CMNs/DWOs/SWOs, and claims. They share the same
HMAC link primitive (`RESUPPLY_LINK_HMAC_KEY`) and the same retention/
chart-filing machinery, but are otherwise separate.

A third, paper-first path closes the loop for faxed provider documents:
outgoing prescription/manual documents are stamped with a `PFS-XXXXXXXX`
barcode, and the **inbound-fax barcode auto-filer** reads it off the
returned page, files it to the chart, and flips the signature-tracking row
to `returned_signed` — no CSR triage. (Behind `fax.auto_file_signed`,
seeded OFF.)

---

## 3. Patient-packet workflow, end to end (verified)

### 3.1 Compose & send

- **Routes:** `POST /admin/patients/:id/packets`, `POST /admin/patient-packets`
  (contact-only), plus auto-send on first delivery
  (`auto-send-on-delivery.ts`, now ON — §6).
- `resolveDocumentKeys()` **folds every compliance-required document back
  in** unless the caller explicitly sent a standalone single-document
  selection — a stale bundle preset can never produce an incomplete packet
  (`send.ts:479`).
- Each document's **effective content is snapshotted** onto
  `patient_packet_documents.content_sections` at send time. Editing a
  template later never rewrites a packet already sent or signed
  (`send.ts:526`, snapshot invariant). Merge tokens (`{{company_name}}`,
  `{{patient_name}}`, …) resolve at render time.
- Delivery is over **email + SMS**, each tenant-scoped
  (`createTenantSendgridClient` / `resolveTenantSmsClientOptions`),
  fire-and-forget, PHI-safe, with per-message usage metering and graceful
  no-op when a channel is unconfigured (`send.ts:790`).

### 3.2 The signed link

- HMAC-SHA256 over the base64url payload `{ id, v (link_version), e (expiry) }`,
  verified with `timingSafeEqual`; **no DB lookup needed to reject a
  tampered or expired link** (`patient-packet-token.ts`).
- **Default TTL is 30 days** (`DEFAULT_TTL_SECONDS`), refreshed on every
  resend/reminder.
- **Revocation is the `link_version`**: resending, voiding, reminding, and
  completing all bump it, so any previously-delivered link is dead. The
  public route re-loads the packet and rejects a stale version
  (`storefront/patient-packets.ts:116`).

### 3.3 Patient signs

- Public, rate-limited (`view` 120/15min, `sign` 30/15min per IP).
- First view stamps `first_viewed_at` and flips `sent → viewed`.
- Sign requires: **every document acknowledged**, explicit **ESIGN
  consent** (`consentEsign: literal(true)`), and — when applicable — a
  **representative reason** (relationship ≠ self), a **POD date-received**,
  and a **valid option for every choice document** (e.g. the ABN's Option
  1/2/3). Typed name is sufficient; a drawn-signature PNG is optional and
  **never logged** (`storefront/patient-packets.ts:280`).
- Finalize is an **optimistic compare-and-set** on status, so a
  double-submit can't double-complete (`:398`).

### 3.4 Return & file in the chart

- On completion the signed PDF (documents + signature certificate) is
  **auto-filed to the patient chart** as a `patient_documents` row tagged
  `agreement`, with retention computed as **7 years when the packet
  includes the Medicare POD, else the 6-year HIPAA floor**
  (`autofile.ts`).
- Fire-and-forget and **idempotent** (`chart_document_id` guard); a render
  or storage failure never delays the patient's signing response, and the
  PDF stays regenerable on demand. Gated by
  `patient_packets.autofile_signed_pdf` (seeded ON).

### 3.5 Track when not returned, and re-send

- **Automatic:** the daily reminder sweep
  (`patient-packet-reminders.ts`) re-issues a fresh link over email + SMS
  for packets still `sent`/`viewed`, after `REMIND_AFTER_DAYS` (3), at most
  `MAX_REMINDERS` (3) times, each claimed with a compare-and-set so
  overlapping runs can't double-send, with the **9am–8pm TCPA window**
  enforced per patient and a **rollback** when delivery fails (so a bad
  delivery day never strands a patient with a dead link). Now ON by
  default (§6).
- **Manual:** `POST /admin/packets/:packetId/resend` works on any open
  packet, any time, over the chosen channels.
- **Visibility:** the admin packet list + the new **Outstanding** worklist
  (§6).

---

## 4. Provider e-sign workflow (verified)

- **Identity:** a provider is a normal `customer`-role auth user linked via
  `provider_portal_accounts` — "provider-ness" is the link, not a role, so
  a provider can never pass `requireAdmin`. **MFA is mandatory** and the
  unified MFA probe means a provider is TOTP-challenged on _every_ sign-in
  surface (the storefront-mount bypass is closed).
- **Capture:** typed name + explicit ESIGN consent (optional drawn
  signature); every lifecycle action appends a **hash-chained**
  `provider_signature_events` row, and a per-document **certificate** or
  per-provider **signature log** PDF can be printed for audit with a
  chain-integrity verdict.
- **Lifecycle:** `pending → signed → ready_to_print → returned_signed →
attached_to_chart → released` (release is record-only — it never mutates
  `insurance_claims` state). Batch signing (`sign-batch`, ≤50) signs each
  document individually server-side, so certificates can't drift.
- **Track when not returned:** `/admin/signature-tracking` is the
  outstanding queue (oldest first), with barcode lookup, mark-returned /
  hand-delivered / cancel, and a provider/practice rollup. `remind`
  re-notifies a provider; the barcode auto-filer closes faxed returns.

This side already had the operator worklist the patient side was missing —
which is exactly the gap §6 closes for patient packets.

---

## 5. Assessment against the brief

| Criterion                                        | Verdict                     | Notes                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Appropriate** (right documents, right content) | ✅ with one known exception | Required documents are enforced and auto-folded; content reviewed in the 06-11 companion. **Exception:** ABN is not the official CMS-R-131 (operator action; now warned in-app — §6).                                                                                                        |
| **Sent appropriately**                           | ✅                          | Tenant-scoped sender, per-channel graceful degradation, PHI-safe, usage-metered, required-doc folding.                                                                                                                                                                                       |
| **Sent timely**                                  | ✅ after this change-set    | Auto-send-on-delivery and auto-remind were OFF; now ON by default (§6). Reminder cadence is configurable.                                                                                                                                                                                    |
| **Good safeguards**                              | ✅                          | HMAC links + `timingSafeEqual`, link-version revocation, 30-day expiry, rate limits, Zod at every boundary, ESIGN consent gate, representative/POD/choice gates, optimistic CAS on finalize, mandatory provider MFA, hash-chained provider log, fail-closed feature flags, PHI never logged. |
| **E-sign → returned → filed in chart**           | ✅                          | Auto-file to chart (idempotent, retention-stamped) for patients; attach-to-chart + barcode auto-file for providers.                                                                                                                                                                          |
| **Tracked when not returned**                    | ✅ after this change-set    | Provider queue already existed; patient packets now have an Outstanding worklist + reminder/aging signal (§6), plus the automatic sweep.                                                                                                                                                     |
| **Re-sendable**                                  | ✅                          | Manual resend (any open packet) + automatic reminders (capped, TCPA-gated, rollback-safe); provider `remind`.                                                                                                                                                                                |

---

## 6. Changes shipped in this change-set

1. **Timeliness on by default (migration `0410`).** Flips
   `patient_packets.autosend_on_delivery` and `patient_packets.autoremind`
   from the seeded OFF to **ON** for every tenant, and updates the Control
   Center descriptions to match. Both paths are safe to run unattended:
   auto-send fires inline per _new_ delivery (never a retroactive backfill)
   and is one-time per patient; the reminder sweep is CAS-claimed,
   TCPA-windowed, capped, and rolls back on delivery failure. New tenants
   inherit ON (they copy the seed org's flags at onboarding). Operators can
   still turn either OFF from the Control Center; because migrations apply
   once, a later opt-out is never re-enabled by a redeploy.

2. **Outstanding (unsigned) patient-packet worklist.**
   `GET /admin/patient-packets?status=outstanding` returns the packets still
   awaiting signature (`sent` + `viewed`), **oldest sent first**, so the most
   overdue paperwork surfaces at the top. It returns up to 500 by default
   (vs. 100 for the recent-list view), with a `?limit=` override (1..1000) to
   page a larger backlog. Both packet-list endpoints now also return
   `first_viewed_at`, `reminder_count`, and `last_reminded_at`. The admin page adds the **Outstanding** filter, a
   **Reminders** column (nudge count + last-nudged date), and an age hint
   on the Sent column. This gives patient packets the same
   "what hasn't come back, and have we chased it?" visibility the provider
   queue already had.

3. **Unlinked (contact-only) packets get SMS reminders too.** A packet
   sent to a bare email/phone with no patient record was previously
   email-only on reminder; the sweep now falls back to the captured
   `recipient_phone` for SMS, with the send-window defaulting to Eastern
   when no timezone is on file — the same posture the initial contact send
   already uses. (New test:
   `patient-packet-reminders.unlinked-sms.test.ts`.)

4. **ABN flagged "not valid for Medicare" in the data model.** The
   intake-forms `abn` acknowledgement now carries an operator-facing
   `complianceNote` (it is a plain-language acknowledgement, **not** the
   official OMB CMS-R-131; liability transfer requires the official form,
   issued before delivery), exposed on the form-acknowledgements summary
   API (`/admin/form-acknowledgements/summary`) and its client type. This
   complements the warning the manual-documents `abn_medicare` template —
   the surface operators actually send an ABN from — **already shows in the
   document library** (description + an in-body CMS form note), so neither
   ABN can be mistaken for a Medicare-valid notice. (The summary endpoint
   is not yet rendered by a page; the note rides the API for whenever an
   accreditation-rollup view is added — the manual-documents warning is the
   live operator-facing guard today.)

5. **Outbound documents must be complete before they send.** Staff-authored
   **manual documents** (CMN, prescription/order, agreement, delivery
   ticket, fax cover) and **manual-document packets** previously had no
   notion of a required field and no pre-send check — a half-filled CMN
   could be faxed out. Now:
   - The catalog carries a per-type **required-field** set
     (`REQUIRED_FIELD_KEYS`): the identity + clinical content a document is
     genuinely invalid without. For the order kinds this includes the
     **diagnosis (ICD-10)** and the **length of need** — a complete order
     carries them, the diagnosis is auto-populated from a validated source
     already on file, and the length of need is supplied by the DME. These
     documents are sent **to the prescriber to review and sign**, so
     pre-filling a validated diagnosis and proposing a length of need is the
     standard, compliant draft-order pattern (the prescriber's signature is
     the medical-necessity attestation) — and it mirrors what the
     prescription-request flow (`validatePrescriptionRequestInputs`) already
     requires. e.g. a prescription requires patient name + DOB + prescriber
     name + NPI + items + ICD-10 + length-of-need.
   - **Auto-populate:** these required fields are exactly what chart prefill
     (`/admin/manual-documents/prefill`) fills from the patient record,
     provider directory, and latest sleep study — including the **validated
     ICD-10 diagnosis** from the sleep study (a diagnosis already on file, not
     authored by the DME). So when the data is in the system it lands in the
     document automatically (blank-only merge; typed values are never
     overwritten); the length of need is the one field the DME fills, and the
     gate flags it until they do.
   - **Flag before send:** `send-email` / `send-fax` (single doc **and**
     packet) now return **`422 document_incomplete`** with the exact
     `missingFields` (or `incompleteDocuments`) when any required field is
     still blank — nothing leaves the building half-finished. The editor
     marks required inputs with a `*`, shows which are outstanding, and
     disables the Send buttons (filing an in-progress draft to a chart stays
     allowed). So: system data fills the document automatically, and
     anything still needed is flagged for entry **before** it can be sent —
     enforced server-side, surfaced client-side.
   - Note: the **prescription-request packets** (the physician-fax order)
     already validated completeness via
     `validatePrescriptionRequestInputs()` (NPI, ICD-10, return fax,
     length-of-need); **patient e-sign packets** auto-fill via merge tokens
     and the patient supplies the signer fields — so this gap was specific
     to the manual-documents surface.

---

## 7. Remaining recommendations (not engineering blockers)

These are operator / business actions, carried over from the 06-11 content
review and confirmed still-open here:

- **Adopt the official CMS-R-131 (March 2026 revision)** before issuing any
  ABN to a Medicare beneficiary. The in-app warning (§6.4) is an interim
  guard, not a substitute for the OMB form.
- **Seed `dme_organization`** (`/admin/company-information`) so no document
  prints the `FALLBACK_COMPANY` placeholder identity.
- **Confirm the reminder cadence** suits the business: defaults are nudge
  after 3 days, every 3 days, up to 3 times
  (`PATIENT_PACKET_REMIND_AFTER_DAYS` / `_INTERVAL_DAYS` / `_MAX_REMINDERS`,
  cron `PATIENT_PACKET_REMINDER_CRON`).
- **Optionally enable the shipment gate** (`orders.require_signed_paperwork`,
  global or per-payer) so a patient-linked order can't ship until the
  required intake paperwork (HIPAA NPP, AOB, Supplier Standards) is signed.
- **Optionally enable `fax.auto_file_signed`** once `ANTHROPIC_API_KEY` is
  set, to auto-file faxed-back provider signatures by barcode.

---

## 8. Files touched

- `lib/resupply-db/migrations/0412_patient_packet_automation_default_on.sql`
- `artifacts/resupply-api/src/routes/admin/patient-packets.ts` (Outstanding
  filter + reminder/aging fields)
- `artifacts/resupply-api/src/worker/jobs/patient-packet-reminders.ts`
  (unlinked-packet SMS) + `…unlinked-sms.test.ts`
- `artifacts/resupply-api/src/lib/intake-forms/catalog.ts` (ABN
  `complianceNote`) + `routes/admin/form-acknowledgements.ts` (surface it)
- `lib/api-client-react/src/admin/patient-packets.ts` (summary type)
- `artifacts/cpap-fitter/src/pages/admin/patient-packets.tsx` (Outstanding
  filter, Reminders column, age hint)

Document-completeness gate (manual documents):

- `artifacts/resupply-api/src/lib/manual-documents/catalog.ts`
  (`REQUIRED_FIELD_KEYS`, `missingRequiredManualDocumentFields`,
  `isRequiredManualDocumentField`) + `catalog.test.ts`
- `artifacts/resupply-api/src/routes/admin/manual-documents.ts` (catalog
  `required` flag + send-email/send-fax gate) + `manual-documents.test.ts`
- `artifacts/resupply-api/src/routes/admin/manual-document-packets.ts`
  (bundle send gate)
- `artifacts/cpap-fitter/src/lib/admin/{manual-documents-api,send-error}.ts`
  (required flag + `document_incomplete` message)
- `artifacts/cpap-fitter/src/pages/admin/admin-documents/{document-editor,send-actions}.tsx`
  (required markers, pre-send flag, blocked Send buttons)

All API-package tests pass. This review reflects the code state at the time
of writing.
