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

| Level         | Scope                              | Where stored                                              |
| ------------- | ---------------------------------- | --------------------------------------------------------- |
| **Permanent** | Every packet sent after the save   | `resupply.patient_packet_template_overrides` (one row/key) |
| **Temporary** | One packet only                    | That packet's `patient_packet_documents.content_sections`  |

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

## Manual-document prefill

`GET /admin/manual-documents/prefill?patientId&documentType` suggests
field + recipient values from the chart (demographics, latest
prescription + its provider, latest sleep-study diagnosis). CMN /
prescription / fax cover suggest the **provider** as recipient;
agreements / delivery tickets suggest the **patient**. The SPA merges
suggestions into **blank inputs only** — typed values are never
overwritten, and nothing is persisted by the endpoint itself.
