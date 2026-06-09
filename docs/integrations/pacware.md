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

## Import semantics — "sync, don't clobber"

The patient-roster import is a **sync** keyed on `pacware_id`: a new
account is inserted, an existing one is updated. The safety rule:

- **Only the columns present in the uploaded report are written.** If your
  report omits the phone column, existing phone numbers are never touched.
- A column that **is** present but **blank** in a row is treated as
  "cleared" (PacWare is the demographics system of record).
- `status` and `created_at` are never overwritten by an import.
- Rows are de-duplicated within a file (last occurrence wins) before write.

Validation is strict and surfaced **before** any write: the upload first
runs a `preview` (parse + validate, no DB) so the operator can fix the
source file. Rows that fail validation are skipped, never partially
written.

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
