# E-sign document templates: viewing, editing, and prefill

_Added 2026-06-10 (migration 0301)._

The patient e-sign packet documents (welcome letter, AOB, NPP, patient
rights, financial responsibility, supplier standards, consent to care,
proof of delivery) used to be hard-coded in
`artifacts/resupply-api/src/lib/patient-packet/templates.ts`. They are
now operator-editable on two levels, viewable as a patient would see
them, and automatically filled from data already in the app.

## Where

- **Admin UI:** `/admin/patient-packets` → **Document templates**
  (view / edit / revert), and per-document **Customize for this packet**
  inside the send panel.
- **Manual documents:** `/admin/documents` → **Prefill from a patient's
  chart** inside the document editor.

## Two levels of editing

| Level         | Scope                            | Where stored                                               |
| ------------- | -------------------------------- | ---------------------------------------------------------- |
| **Permanent** | Every packet sent after the save | `resupply.patient_packet_template_overrides` (one row/key) |
| **Temporary** | One packet only                  | That packet's `patient_packet_documents.content_sections`  |

Deleting the override row (the **Revert to default** button) restores
the built-in wording. The code templates remain the single source of
truth for defaults.

## Snapshot semantics (the invariant)

At **send time** the effective content (default or override, plus any
one-off edit) is snapshotted onto each
`patient_packet_documents.content_sections` row. The signing UI and the
signed PDF both render from the snapshot. Consequences:

- Editing a template **never rewrites** a packet that was already sent
  or signed.
- Rows created before migration 0301 have a NULL snapshot and keep
  rendering from the code template by `document_key` (the historical
  behavior), so old packets are unaffected.
- `content_version` records what was rendered:
  `2026-06-06.v1` (default), `…+custom.r3` (override revision 3),
  `…+edited` (one-off per-packet edit).

## Merge tokens (prefill from app data)

Editable content is stored with `{{merge_tokens}}` resolved at render
time, so a renamed organization or a different recipient flows into the
text without re-editing:

`{{company_name}}`, `{{company_phone}}`, `{{company_email}}`,
`{{company_address}}`, `{{company_city_state_zip}}`, `{{company_npi}}`,
`{{patient_name}}`, `{{patient_first_name}}`, `{{patient_email}}`,
`{{patient_phone}}`, `{{today}}`.

Company values come from the DME organization row
(`resolveCompanyProfile`); patient values from the packet's snapshotted
recipient. Saves reject unknown tokens (HTTP 400 listing the valid
set); renders leave unknown tokens verbatim rather than crash.

The Proof of Delivery's CMS-required itemization (equipment list,
delivery date/address) is **spliced in automatically** after the first
section — an operator edit can change the wording but can never drop
the item list.

## Editing format

The admin editor presents structured sections as plain text
(`artifacts/cpap-fitter/src/lib/admin/packet-template-text.ts`):

```
# Heading
A paragraph. Blank line starts a new paragraph.

- A bullet
- Another bullet

---            ← section divider
```

Content stays structured (headings / paragraphs / bullets, never HTML),
preserving the signing UI's no-markup-injection property.

## API

- `GET    /admin/patient-packet-templates` — effective content + code
  defaults + merge-token catalog (`patients.read`).
- `PUT    /admin/patient-packet-templates/:key` — save a permanent
  override (`admin.tools.manage`).
- `DELETE /admin/patient-packet-templates/:key` — revert to default
  (`admin.tools.manage`).
- `POST   /admin/patient-packet-templates/:key/preview` — render (with
  optional unsaved draft sections) against the live company profile +
  sample patient values; read-only (`patients.read`).
- The two send routes and `PATCH /admin/packets/:packetId` accept
  `documentOverrides: [{ documentKey, title?, sections }]` for one-off
  edits (open packets only; closed packets stay immutable).

Audit actions: `patient_packet_template.updated` / `.reverted` (key +
revision only — never the content).

## Packet bundle presets

_Migration 0302._ Named bundles of documents (e.g. "Medicare new
patient" vs "Commercial new patient") managed from the send panel on
`/admin/patient-packets`: apply one with a click, save the current
selection as a new bundle, or delete one. Stored in
`resupply.patient_packet_presets`; reads need `patients.read`,
save/delete need `admin.tools.manage` (audited). Presets are a
selection convenience only — the send path still folds in every
compliance-required document and re-validates keys, so a stale preset
can never produce an incomplete packet.

- `GET    /admin/patient-packet-presets`
- `POST   /admin/patient-packet-presets` `{ name, documentKeys, packetTitle?, description? }`
- `DELETE /admin/patient-packet-presets/:presetId`

## Provider portal: batch signing

The provider queue offers checkboxes on pending documents plus a
**Sign N selected** flow: one typed name + one ESIGN consent (+ one
optional drawn signature) executed against every selected document via
`POST /api/provider/queue/sign-batch` (max 50 ids). Each document is
still signed **individually** server-side — its own status-guarded row
update, its own attestation statement, its own hash-chained `signed`
event (flagged `viaBatch: true`) — so certificates and audit trails are
identical to one-at-a-time signing. Ineligible documents (already
signed / declined / expired / not the provider's) are skipped and
reported back, never silently signed. The single-document route and the
batch route share one `executeSignature` helper so the captures can't
drift.

## Provider portal: drawn signature (optional)

_Migration 0302._ The provider signing screen now offers an optional
signature pad alongside the typed name + ESIGN consent (which remain
the legally sufficient capture). When drawn, the PNG data URL is stored
on `provider_signature_requests.signature_image` (never logged, never
in the hash-chained event payload — the event records only
`hasDrawnSignature: true`) and is embedded in the signature certificate
and provider signature-log PDFs. A dedicated 1 MB JSON parser is
mounted for `/api/provider/queue` in `app.ts`, mirroring the
patient-packet sign route.

## MFA enrollment QR codes

Both MFA enrollment screens — the provider portal setup page and
`/admin/security` — now render the `otpauth://` URI as a scannable QR
code (`qrcode` package, rendered client-side in
`src/components/QrCode.tsx`; the secret never leaves the browser). The
manual-entry key and tap-to-open link remain as fallbacks.

## Manual-document prefill

`GET /admin/manual-documents/prefill?patientId&documentType` suggests
field + recipient values from the chart (demographics, latest
prescription + its provider, latest sleep-study diagnosis). CMN /
prescription / fax cover suggest the **provider** as recipient;
agreements / delivery tickets suggest the **patient**. The SPA merges
suggestions into **blank inputs only** — typed values are never
overwritten, and nothing is persisted by the endpoint itself.
