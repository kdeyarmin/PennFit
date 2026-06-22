# Runbook — ADR / Audit-Packet & Patient AR Collections

How to turn on, operate, and (safely) roll out the three features added for the
billing-gap work. All three ship **OFF** and are inert until you enable them.

- **ADR / audit-response queue** + **audit-packet creator** — flag
  `billing.adr_queue`
- **Patient AR dunning / collections** — flags `collections.dunning` and
  `collections.agency_export`

Flags are per-tenant (System Configuration → Control Center, or the
`/admin/feature-flags` API). Turning a flag on for one tenant never affects
another.

---

## 1. ADR queue + Audit Packet Creator

### What it does

Log a payer/contractor Additional Documentation Request against its response
deadline, then assemble the requested records into one PDF to send back. The
audit-packet builder pulls stored chart documents and generates summaries
(cover sheet, adherence/compliance, equipment detail, claim summary, etc.) from
data already in the system.

### Enable

1. Control Center → turn **`billing.adr_queue`** ON for the tenant.
2. (Optional) schedule the nightly SLA refresh so deadline buckets advance on
   their own:
   - env `ADR_SLA_SWEEP_CRON` (default `37 4 * * *` once the job is provisioned).
   - The sweep is a pure cache refresh — no messages, no audit rows. Safe to run.

### Operate

- **Billing → ADR / audit response** — open ADRs ranked by deadline, with
  overdue / at-risk badges and outstanding-document counts. Use **Log ADR** to
  record a new request (patient, optional claim, source/contractor, scope, and
  the response-due date). Logging seeds the response checklist from the default
  set for the audit scope.
- **Build packet** (from an ADR row, or the **Audit packet** action on a
  patient page) → choose the audit type (PAP device / supplies / both), toggle
  the checklist, and **Generate**. You get one combined PDF, and a summary of
  any selected items that had **no document on file** (so you can chase them
  before sending — gaps are never printed into the auditor's packet).

### Notes

- The catalog is grounded in the CMS / DME-MAC PAP documentation set (SWO,
  face-to-face, qualifying sleep study, day-31–91 re-eval, adherence, POD,
  AOB/ABN, etc.). Items marked _on file_ embed stored documents; _generated_
  items are derived from system data; _on file / generated_ (hybrid) prefer a
  stored document and fall back to a generated summary.
- HEIC/WebP image attachments can't be embedded (only PDF/JPEG/PNG); such a
  document is reported as skipped rather than failing the build.
- This is operational tooling — it writes to its own tables and
  `insurance_claim_events`, never the retired `audit_log`.

---

## 2. Patient AR Dunning / Collections

### What it does

Escalates unpaid patient-responsibility balances on a ladder
(statement → reminder → second notice → final notice → agency), and **stops the
moment** the balance is paid or the patient goes onto a payment plan / autopay.
Sends go through the existing statement path, so consent and quiet-hours are
enforced exactly as a hand-sent statement. The agency step never auto-sends —
it parks the run for a reviewed export.

### Enable (recommended: dry-run first)

1. Control Center → turn **`collections.dunning`** ON for the tenant.
2. **Do not schedule the crons yet.** With the flag on but no cron, nothing
   runs automatically. Verify behavior first:
   - The default ladder, floor (`$25`), and channels live in code
     (`DEFAULT_DUNNING_POLICY`, `DUNNING_MIN_BALANCE_CENTS`).
   - Confirm patient balances resolve as expected for your data (open AR =
     unpaid claim responsibility − succeeded payments).
3. When satisfied, schedule the two jobs:
   - `COLLECTIONS_DUNNING_SCAN_CRON` (default `17 5 * * *`) — opens runs.
   - `COLLECTIONS_DUNNING_TICK_CRON` (default `0 18 * * *`, ~1pm ET / 10am PT,
     inside the US SMS window) — escalates due runs.
4. (Optional) turn **`collections.agency_export`** ON only when you have an
   agency relationship and want the agency CSV export enabled.

> **Why dry-run.** The open-scan/tick jobs read live financial data and send
> patient-facing messages. The flag + unscheduled crons let you confirm the
> queue populates correctly before any message goes out. Everything is
> consent/quiet-hours gated, but the rollout is yours to pace.

### Operate

- **Billing → Collections** — active and paused runs, highest balance first,
  showing the ladder step each is on. **Pause** (e.g. a disputed balance),
  **Resolve** (written off / paid by hand), or **Cancel** a run. Runs also
  de-escalate automatically on the next tick when the balance clears or a plan
  starts.
- **Agency export** (when `collections.agency_export` is on) — downloads a
  formula-injection-guarded CSV of runs that reached the agency step. Nothing is
  ever sent to an agency automatically; the export is a deliberate action.

### Turn it off

Flip `collections.dunning` OFF (or remove the crons). OFF pauses all sends
without cancelling runs — turning it back on resumes where it left off.

---

## Quick reference

| Feature       | Flag(s)                                               | Cron env (optional)                                              | Admin surface                           |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| ADR queue     | `billing.adr_queue`                                   | `ADR_SLA_SWEEP_CRON`                                             | Billing → ADR / audit response          |
| Audit packet  | `billing.adr_queue`                                   | —                                                                | "Build packet" / patient → Audit packet |
| Dunning       | `collections.dunning`                                 | `COLLECTIONS_DUNNING_SCAN_CRON`, `COLLECTIONS_DUNNING_TICK_CRON` | Billing → Collections                   |
| Agency export | `collections.agency_export` (+ `collections.dunning`) | —                                                                | Billing → Collections                   |

All flags seed OFF (migrations 0457 / 0458). Pure decision logic lives in
`@workspace/resupply-domain` (`claim-adr`, `audit-packet-catalog`, `dunning`)
and is unit-tested.
