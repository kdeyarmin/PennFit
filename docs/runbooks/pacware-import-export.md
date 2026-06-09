# PacWare ⇄ PennFit: import & export manual

A step-by-step guide for the operations team to move data between
**PacWare** (the DME billing system) and **PennFit**. No code or developer
access required — everything here is done from the PacWare desktop client
and the PennFit admin console.

> **Why files?** PacWare has no API. The supported way to move data is the
> CSV reports PacWare can export and the CSV its import screens can read.
> Background: [`docs/integrations/pacware.md`](../integrations/pacware.md).

**Where in PennFit:** sign in to the admin console → left nav →
**Operations → PacWare** (`/admin/pacware`). You need an admin account
(the page requires the `admin.tools.manage` permission).

The page always shows a live **Column reference** at the bottom — those
tables come straight from the code, so they are authoritative if anything
here looks out of date.

---

## Part 1 — Import patients from PacWare into PennFit

Do this whenever you add patients in PacWare, or on a regular cadence
(weekly is a good default) so PennFit's roster matches PacWare.

### 1.1 Run the Patient List report in PacWare

1. Open PacWare and go to **Reports → Patient List** (also called _Patient
   Demographics_ in some installs).
2. Set the filter to the patients you want to sync (all active patients, or
   a date range of recently added/edited patients).
3. Choose **Export → CSV** (or "Export to file → Comma-delimited"). Save it
   somewhere you can find it, e.g. `Desktop\pacware-patients.csv`.

> **Tip — only the columns you include are synced.** If you export a report
> that has the name and account number but no phone column, PennFit will
> update names and **leave existing phone numbers untouched**. If a column
> _is_ in the report but a cell is blank, PennFit treats that as "cleared".
> So: include every column you want to keep authoritative, and omit columns
> you don't want to overwrite.

### 1.2 Required and optional columns

The importer matches your report's column headers loosely — capitalization,
spaces, and underscores don't matter, and common aliases are accepted
(e.g. `Account Number`, `DOB`, `Zip`, `Primary Insurance`).

| PennFit column     | Required | PacWare report field (typical) | Notes                                   |
| ------------------ | -------- | ------------------------------ | --------------------------------------- |
| `pacware_id`       | **yes**  | Account Number / Patient ID    | The join key. Must be stable.           |
| `legal_first_name` | **yes**  | First Name                     |                                         |
| `legal_last_name`  | **yes**  | Last Name                      |                                         |
| `date_of_birth`    | **yes**  | DOB                            | Must be **YYYY-MM-DD** (see 1.5).       |
| `phone_e164`       | no       | Phone                          | Must be **E.164**, e.g. `+12155551212`. |
| `email`            | no       | Email                          |                                         |
| `address_line1`    | no       | Address                        | If you send an address, send all four:  |
| `city`             | no       | City                           | line1 + city + state + postal_code.     |
| `state`            | no       | State                          |                                         |
| `postal_code`      | no       | Zip                            |                                         |
| `address_line2`    | no       | Apt / Suite                    |                                         |
| `country`          | no       | Country                        | Defaults to `US`.                       |
| `insurance_payer`  | no       | Primary Insurance              | Drives resupply cadence rules.          |

### 1.3 Upload and preview

1. In PennFit go to **Operations → PacWare → Import patient roster**.
2. Click **Choose CSV file** and pick the file you exported.
3. PennFit shows a **preview** — no data is saved yet:
   - **Rows in file / Valid / Errors** counts.
   - An **Ignored columns** notice for any header that isn't part of the
     roster layout (harmless — just so you can confirm the right export).
   - An **errors table** listing each bad row by number, the field, and the
     problem (the bad value itself is never shown — it's PHI).

### 1.4 Commit

1. If the valid count looks right, click **Import N patients**.
2. PennFit creates new patients and updates existing ones (matched on
   `pacware_id`) and shows **Synced N patients**.
3. Rows with errors are skipped. Fix them in PacWare (or in the CSV) and
   re-upload — re-running is safe; it updates rather than duplicates.

### 1.5 Fixing the two most common errors

- **"must be YYYY-MM-DD"** — PacWare often exports dates as `MM/DD/YYYY`.
  In Excel: select the DOB column → Format Cells → Custom → `yyyy-mm-dd`,
  then re-save as CSV. (Or set PacWare's export date format if available.)
- **"must be E.164 …"** — phone numbers need the country code and a leading
  `+`, no spaces or dashes: `+12155551212`. If your phones are
  `(215) 555-1212`, either fix the column in Excel or simply **omit the
  phone column** from the export (existing phones are then left as-is).

> **Size limit:** 5,000 rows per upload. For a larger roster, filter the
> PacWare report into batches (e.g. by last-name range) and upload each.

---

## Part 2 — Export PennFit data for PacWare

PennFit produces two CSVs from **Operations → PacWare → Export for
PacWare**. Both download straight to your computer.

### 2.1 Patient roster (`pacware-patient-roster-<date>.csv`)

The full PennFit roster in the **same layout as the importer** — so it
round-trips. Use it to:

- seed PacWare with patients first captured in PennFit, or
- reconcile the two systems (open both rosters in Excel and compare).

Includes demographics, the full address, and `insurance_payer`. To import
into PacWare, use **PacWare → Import / Patient Upload** and map the columns
by their headers.

### 2.2 Resupply-due worklist (`pacware-resupply-due-<status>-<date>.csv`)

PennFit owns resupply (cadence rules + patient outreach). When a resupply
is ready, hand it to PacWare to pick, ship, and **bill**. This export is
**one line per due item**:

| Column               | Meaning                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `pacware_id`         | Patient account number — look the patient up in PacWare.                                       |
| `patient_last_name`  | Patient last name.                                                                             |
| `patient_first_name` | Patient first name.                                                                            |
| `item_sku`           | The item to dispense.                                                                          |
| `quantity`           | Always `1` per line.                                                                           |
| `due_date`           | When the resupply is due.                                                                      |
| `status`             | PennFit episode status at export time.                                                         |
| `insurance_payer`    | For billing routing.                                                                           |
| `pennfit_episode_id` | Reconciliation handle — paste into the PacWare order note so you can match it back to PennFit. |

**Status selector:** next to the button, pick which episodes to export.
`confirmed` (default) = the patient said yes and it's ready to ship & bill.
Other options (`approved`, `pending`, `outreach_pending`) give a broader
"upcoming" view.

**Suggested workflow:** export `confirmed` daily → in PacWare, create one
order per line (account number → item → qty) → paste `pennfit_episode_id`
into the order note → ship & bill in PacWare as usual.

> **Size limit:** 5,000 rows. If the download header shows it was capped,
> narrow the status filter and export again.

---

## Part 3 — Recommended cadence

| Cadence | Action                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ |
| Daily   | Export **Resupply due (confirmed)** → enter orders in PacWare.                             |
| Weekly  | Import the **Patient List** from PacWare → keeps PennFit demographics + insurance current. |
| Ad hoc  | After a bulk add/edit in either system, run the matching import/export to reconcile.       |

## Troubleshooting

| Symptom                                   | Cause / fix                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| "Ignored columns" warning on import       | Headers PennFit doesn't recognize (e.g. `balance_due`). Harmless — confirm it's the right report.                  |
| All rows error with "Pacware ID required" | The account-number column isn't recognized. Rename its header to `pacware_id` (or `Account Number`) and re-export. |
| Export button says session expired (401)  | Your sign-in lapsed. Refresh the page and sign in again.                                                           |
| Export capped at 5,000 rows               | Narrow the filter (status for resupply; patient `status` for the roster) and export again.                         |
| A patient updated unexpectedly            | The import is a **sync** — a present, blank cell clears that field. Omit columns you don't want to overwrite.      |
