# PacWare integration

How PennFit exchanges data with **PacWare**, the practice's legacy DME/HME
billing system.

For the operator's step-by-step (how to run each report, upload it, and
import PennFit's exports back into PacWare), see the runbook:
[`docs/runbooks/pacware-import-export.md`](../runbooks/pacware-import-export.md).

## What PacWare is — and why there is no live API

PacWare is a Windows **client-server** HME/DME package that handles
Billing, Inventory Tracking, Reporting, and Cash Application for home
medical equipment companies. It was acquired by Brightree (~2009–2011);
Brightree still supports the client-server product but steers customers to
its web platform.

It exposes **no network/HTTP API, no webhooks, and no message queue** — it
is an on-premise desktop application. There is therefore nothing for
PennFit to "connect" to. We evaluated:

| Option                           | Verdict                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| REST/HTTP adapter (like AirView) | ❌ No API exists. PacWare is a desktop client over a LAN database.                            |
| Direct database read             | ❌ Proprietary on-prem schema, no remote access, unsupported, and brittle across upgrades.    |
| Screen scraping / RPA            | ❌ Fragile, unsupported, and would run on the operator's PC — out of scope for a web app.     |
| **CSV file exchange**            | ✅ PacWare's own reports export to CSV, and its import screens read CSV. Durable + supported. |

**Decision: a CSV file exchange**, in both directions. This is the same
posture PacWare itself uses for a Brightree migration (export reports →
transform → import), so it is the well-trodden path.

This mirrors how the rest of the integrations layer already treats PacWare:
the `patients` table is keyed on `pacware_id` (the PacWare account number),
the original `/patients/import-csv` route was built for a "Pacware-style
export," and the clinical equipment registry is explicitly noted as
"distinct from Pacware warehouse inventory." PacWare is the **billing +
warehouse system of record**; PennFit is the **patient-engagement +
resupply engine**.

## Architecture

```
   PacWare (operator's PC)                         PennFit
   ┌─────────────────────┐                  ┌───────────────────────────┐
   │ Patient List report │ ── export CSV ─▶ │ Admin → PacWare → Import   │
   │                     │                  │   parse + validate + sync  │
   │                     │                  │   (patients.pacware_id)    │
   │                     │                  │                           │
   │ Order entry /       │ ◀─ import CSV ── │ Admin → PacWare → Export   │
   │ billing             │                  │   patient roster          │
   │                     │                  │   resupply-due worklist    │
   └─────────────────────┘                  └───────────────────────────┘
```

### Components

| Layer    | Where                                                     | Responsibility                                                                                                                                                                             |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract | `lib/resupply-integrations-pacware`                       | Pure package (only `zod`): report **column catalog**, tolerant CSV **parser**, CSV **exporter**, availability. Single source of truth for layouts. Imports into both Node and the bundler. |
| API      | `artifacts/resupply-api/src/routes/admin/pacware.ts`      | `GET /admin/pacware/status`, `POST /admin/pacware/import/patients`, `GET /admin/pacware/export/patients.csv`, `GET /admin/pacware/export/resupply-due.csv`. Owns DB + audit.               |
| UI       | `artifacts/cpap-fitter/src/pages/admin/admin-pacware.tsx` | Admin → **PacWare** page: upload + preview + commit, export buttons, live column reference.                                                                                                |

Because the column catalog lives only in the package, the parser, the
exporter, the `status` endpoint, the admin UI's "Column reference", and
this documentation can never drift apart.

### Supported exchanges

| Report           | Direction | Maps to / from                                                                                      |
| ---------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `patient_roster` | both      | `resupply.patients` (demographics + address + `insurance_payer`), keyed on `pacware_id`.            |
| `resupply_due`   | export    | `resupply.episodes` ⋈ `prescriptions` ⋈ `patients` — one line per due item for PacWare order entry. |

## Import semantics — "fill only, never overwrite"

The patient-roster import is a **fill-only sync** keyed on `pacware_id`:

- **New patients** (no matching `pacware_id`) are **inserted** with every
  field the report provides.
- **Existing patients** are only **topped up**: a field is written **only
  when it is currently blank in PennFit** and the report carries a value
  for it. A value already in PennFit is **never overwritten**.
- Required fields (`legal_first_name`, `legal_last_name`, `date_of_birth`)
  are `NOT NULL` on existing rows, so they can never be filled/overwritten;
  `status` and `created_at` are never touched.
- A column the report omits is never written; a present-but-blank cell on a
  patient who already has that value is left as-is.
- Rows are de-duplicated within a file (last occurrence wins) before write.

The response (and `patient.pacware_sync` audit row) reports **created /
updated / unchanged** counts. "updated" means one or more blank fields were
filled; "unchanged" means the patient already had everything the report
offered.

> Why fill-only? PennFit and PacWare can both hold demographics; a fill-only
> merge lets PacWare backfill gaps in PennFit without a stale PacWare export
> ever clobbering a fresher value a patient just updated in PennFit.

Implementation note: the sync reads existing rows in chunks of 200 (to keep
the `.in(pacware_id,…)` lookup URL bounded), batch-inserts the new patients,
and issues a small per-row `UPDATE` only for existing patients that actually
have a blank to fill (rare once a roster has synced once).

Validation is strict and surfaced **before** any write: the upload first
runs a `preview` (parse + validate, no DB) so the operator can fix the
source file. Rows that fail validation are skipped, never partially
written.

## Sync to PacWare — verify before sending

The PennFit → PacWare exports are surfaced as **"Sync to PacWare"** actions
(patient roster + resupply-due worklist). Each opens a **verify** step that
calls a preview endpoint (`GET /admin/pacware/sync/{patients,resupply-due}/preview`)
returning the **total count + a sample of the actual rows** — no file is
produced and (being a GET) nothing is persisted. The operator confirms,
then the CSV downloads from the existing `export/*.csv` endpoint. The
preview and the download share the same mapper, so what you verify is
exactly what you get.

## Automatic vs manual sync

A persisted toggle (`GET`/`PUT /admin/pacware/settings`, stored under the
non-catalog `app_config` key `pacware.auto_sync`) controls the **in-app
notice**:

- **Manual** (default): no proactive nudging — sync on demand.
- **Automatic**: the page shows a "ready to sync" banner with the live
  pending counts (confirmed resupply orders + roster size).

PacWare has no API and the server filesystem is ephemeral (Railway), so
"automatic" **never pushes PHI anywhere on its own**. It only surfaces the
pending counts (computed live by the settings endpoint) so an admin can
verify + download. Nothing leaves the app without a human confirming.

## PHI & security posture

- **Admin-gated.** Status requires `admin.tools.manage`; import/export
  require `requireAdmin` (the same gate as `/patients/import-csv`).
- **No PHI in logs.** Uploaded rows and exported rows are patient data.
  This code path never logs row contents; audit rows carry **structural
  counts only** (rows synced, error count, …) — never names, DOBs, or the
  offending cell value. (CLAUDE.md hard rules: treat every log line as
  world-readable; no order/PHI bodies in the logger.)
- **`Cache-Control: no-store`** on every import response and CSV export so
  PHI never lands in a proxy/browser cache.
- **CSV formula-injection guard.** Every exported cell is neutralised
  against spreadsheet formula injection (`=`, `+`, `-`, `@`, …). The
  importer reverses this guard so a PennFit export re-imports losslessly
  (e.g. an E.164 phone `+1…` exported as `'+1…` parses back to `+1…`).
- **Rate-limited** via the shared admin read/write limiters.

## Configuration

The exchange is a manual file flow and needs **no credentials**, so it is
always available. Two optional env vars tune it:

| Variable                    | Default | Effect                                                                                                        |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `PACWARE_EXCHANGE_DISABLED` | unset   | `=1` disables the surface (kill switch); `status` reports `disabled`.                                         |
| `PACWARE_FILE_OUTBOX_DIR`   | unset   | Reserved for future server-written exports (automation / DR). Not required for the interactive download path. |

## Limits

- Import: **5,000 rows per upload** (split larger rosters); body capped at
  12 MB (raised for the import path in `app.ts`).
- Export: **5,000 rows**, then `X-Truncated: true` (narrow the filter).
