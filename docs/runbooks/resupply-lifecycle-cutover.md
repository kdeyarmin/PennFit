# Runbook — tenant-by-tenant resupply lifecycle cutover

**Owner:** the operator responsible for a tenant's resupply programme.
**Applies to:** `resupply.due_at_authoritative` and
`resupply.ship_evidence_required` (seeded OFF by migration 0538).
**Never do this for more than one tenant at a time.**

---

## What these two flags actually change

They are not configuration. Each changes **when a live patient is next
contacted**, and each has a failure mode that is invisible until patients
call.

### `resupply.due_at_authoritative`

|                               | Behaviour                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OFF** (today, every tenant) | The hourly scan derives due-ness from how long ago the last order was queued. `episodes.due_at` is a sort key.                                     |
| **ON**                        | The scan reminds an episode once its own `due_at` passes, and that date is recomputed from real shipment evidence whenever a shipment is recorded. |

**The hazard.** `due_at` is written **once**, by `openOutreachEpisode`,
from the caller's `prescriptions.cadence_days`. The scan resolves cadence
through `resolveOutreachPlan`, which prefers
`patients.cadence_override_days`, then the first matching
`frequency_rules` row, and only then the prescription default. For every
patient with an override or a matching payer/SKU rule, **the stored date
encodes the wrong cadence.** Harmless while the scan ignores it. The
moment the flag makes it authoritative: every episode whose stale date has
already passed becomes due at once — a reminder burst across the whole
book — and every episode whose stale date is far in the future goes
silent.

### `resupply.ship_evidence_required`

|                 | Behaviour                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OFF** (today) | The next cycle opens as soon as the patient confirms, dated from the confirm. `recordShipmentEvidence` re-anchors it when evidence arrives, so the confirm date is a provisional estimate, not a guess nobody revisits. |
| **ON**          | The next cycle opens when a shipment is **recorded**, dated from the actual ship date.                                                                                                                                  |

**The hazard.** A tenant with no evidence pathway would depend entirely on
the safety-net grace sweep, and every cycle would close
**`assumed_shipped`**. That is deliberately **not** a shipment: the sweep
never touches the fulfillment, because inventing a ship date for a payer is
a compliance problem, not a data-quality one. `assumed_shipped` can never
date a claim.

Either way **a patient keeps being reminded** — the grace sweep is the
floor. That is the only reason this flag is safe to offer at all.

---

## The workflow

Four steps, in order. The gate is step 2; step 3 re-runs it.

### 1. Assess — read-only, changes nothing

**From the console** (`reports.read`):

```http
POST /resupply-api/admin/resupply-cutover/resupply.due_at_authoritative/assess
{ "evidenceId": "OPS-1234" }
```

**From a terminal** — use this for a large tenant. The HTTP path scans
under a row budget so a request cannot run for minutes; a big tenant comes
back `truncated`, which **blocks**. The CLI has no budget:

```bash
pnpm --filter @workspace/scripts resupply:cutover -- --org=<uuid>
pnpm --filter @workspace/scripts resupply:cutover -- --all-orgs   # plan the order
```

Running with no action flag is the assessment, and it is read-only.

Both write the same `resupply_cutover_records` row, so an assessment run
in a terminal authorises an enable clicked in the console.

### 2. Read the verdict

**`resupply.due_at_authoritative`** reports:

| Metric                                      | Meaning                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `applicablePrescriptions`                   | active prescriptions — the denominator                                       |
| `openEpisodes`                              | episodes still in the ladder, **including `address_hold`**                   |
| `addressHoldEpisodes`                       | parked cycles; they still carry a stale date                                 |
| `missingDueAt`                              | **blocker** — with the flag on the scan cannot see these patients at all     |
| `agreeing` / `drifting`                     | stored date matches / disagrees with the resolved cadence                    |
| `driftingEarlier` / `driftingLater`         | direction of the move                                                        |
| `maxDriftEarlierDays` / `maxDriftLaterDays` | worst case in each direction                                                 |
| `unresolvable`                              | counted, never ignored — missing prescription/patient or an unparseable date |
| `byStatus` / `byReason`                     | grouped counts                                                               |
| `truncated`                                 | **blocker** — a partial clean read is not evidence of a clean tenant         |

**`resupply.ship_evidence_required`** reports:

| Metric                                                        | Meaning                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pathways`                                                    | which evidence sources this tenant has actually **used** (a PacWare account nobody imports from writes no ship dates) |
| `viaPacwareImport` / `viaAdminManual` / `viaCarrier`          | per-source counts                                                                                                     |
| `fulfilledNotShipped`                                         | queued >30d with no evidence — the shape of a broken import                                                           |
| `assumedShippedEpisodes` vs `shippedEpisodes`                 | the honest measure of the gap                                                                                         |
| `claimsAnchoredToShipEvidence` vs `claimsWithoutShipEvidence` | date-of-service provenance                                                                                            |

**Blockers, and what to do about each:**

| Code                           | Fix                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `due_at_drift`                 | Run the backfill (below), then re-assess.                                                                           |
| `missing_due_at`               | Same — the backfill stamps `due_at` and `expires_at`.                                                               |
| `assessment_truncated`         | Re-run from the CLI.                                                                                                |
| `no_shipment_evidence_pathway` | Configure the PacWare shipped-orders import, or have staff mark shipments. Re-assess once real evidence is flowing. |
| `unresolved_shipment_backlog`  | Work the backlog. Raise the threshold only if you understand why the count is high.                                 |
| `assumed_shipped_dominates`    | The ladder is being kept alive by the safety net, not by shipments. Fix the pathway first.                          |

**The due-date backfill** (write mode; run the dry-run first):

```bash
pnpm --filter @workspace/scripts resupply:backfill-due-at -- --org=<uuid> --dry-run
pnpm --filter @workspace/scripts resupply:backfill-due-at -- --org=<uuid>
```

### 3. Enable — one tenant, with a confirmation and an evidence id

```http
POST /resupply-api/admin/resupply-cutover/<flag>/enable
{ "confirm": "ENABLE", "evidenceId": "OPS-1234" }
```

```bash
pnpm --filter @workspace/scripts resupply:cutover -- --org=<uuid> \
  --enable=resupply.due_at_authoritative --confirm=ENABLE --evidence=OPS-1234
```

- `confirm` is the literal string `ENABLE`, not a boolean — a boolean is
  something a script sets to `true` by default.
- `evidenceId` is required. Put the same string on the ticket; that is
  what ties the row here to the record outside the system.
- Requires `admin.tools.manage` (super-admin).
- **The route re-assesses at enable time.** A stored pass authorises the
  click; a fresh assessment decides the outcome. A tenant that passed an
  hour ago can have imported a book of patients since.
- A verdict older than **14 days** reads as `validation_expired` and will
  not authorise an enable. A tenant assessed in March and flipped in July
  was not really assessed.

### 4. Watch, for at least one full reminder tick (one hour)

| Where                             | What you are looking for                                                          |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `/admin/analytics/order-outcomes` | a step change in cycles opened or reminders sent                                  |
| `/admin/operations`               | worker health, reminder-send volume                                               |
| `assumed_shipped` vs `shipped`    | after `ship_evidence_required`, `shipped` should climb and `assumed_shipped` fall |

---

## Rollback

```http
POST /resupply-api/admin/resupply-cutover/<flag>/rollback
{ "confirm": "ROLLBACK", "reason": "reminders firing early for override patients" }
```

```bash
pnpm --filter @workspace/scripts resupply:cutover -- --org=<uuid> \
  --rollback=<flag> --confirm=ROLLBACK --reason="<why, >=10 chars>"
```

- **Rollback is deliberately not gated on readiness.** Turning a flag back
  off restores the behaviour every other tenant already has; a
  data-quality check must never stand between an operator and the stop
  button.
- The reason is required. A rollback without one is indistinguishable from
  a flag that was never turned on.
- The rollback is recorded with `readiness_status = 'blocked'`, so the
  **next enable has to re-earn its verdict** rather than finding a stale
  `ready` behind it.
- Rolling back does not undo the backfill, and does not need to: the
  backfilled `due_at` is simply ignored again while the flag is off.

---

## Readiness states in the console

`GET /resupply-api/admin/resupply-cutover`

| State                | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `not_evaluated`      | nobody has assessed this tenant                                                  |
| `ready`              | assessed, clean, within the 14-day window                                        |
| `blocked`            | assessed, and something is wrong — **age never turns a failure into an unknown** |
| `validation_expired` | assessed and clean, but too long ago to rely on                                  |

The response also carries `enabledWithoutRecord`. A flag that is ON with
no `enable` record was flipped from the generic `/admin/feature-flags`
page, bypassing the assessment. That page is deliberately **not** locked
down — an operator with `admin.tools.manage` can always reach the switch,
and pretending otherwise would be a lie about where it lives. What the
workflow adds is the supported path and the record that says which one was
used.

---

## Invariants this workflow must not break

- **Never enable either flag in a migration.** A migration runs on every
  deploy for every tenant at once — the precise opposite of a per-tenant
  cutover gated on that tenant's own evidence. Migration 0540 creates the
  record table and writes **no** flag values.
- **Never enable during a deploy.** There is no code path that does; keep
  it that way.
- **`assumed_shipped` is not a shipment.** It must never appear in an
  actual-shipped count, and must never date a claim.
- **A grace-period advance is not shipment evidence.** The sweep closes
  the episode and never touches `fulfillments.shipped_at`.
- **Eligibility is not authorisation.** Neither flag changes that.

---

## The audit trail

`resupply.resupply_cutover_records` (migration 0540) holds one row per
decision: flag, previous and new value, actor, timestamp, readiness
verdict, the full report it came from, the evidence id, and a rollback
reason when applicable.

Two invariants are enforced **in the database**, not only in the route,
because a second writer (the CLI) reaches the same table:

- `action = 'enable'` implies `readiness_status = 'ready'`.
- `action = 'rollback'` implies a `rollback_reason` of at least 10
  characters.

History:

```http
GET /resupply-api/admin/resupply-cutover/<flag>/history
```

**PHI:** reports carry counts, day-deltas and capped samples of internal
episode/fulfillment UUIDs. No names, contact details, payer, address or
clinical content — asserted by a test.

---

## Evidence to retain per tenant

1. The assessment output (console response or CLI stdout) showing
   `status: ready` and zero blockers.
2. The `resupply_cutover_records` row id returned by the enable.
3. The `evidenceId` — the same string on the ticket.
4. A screenshot or export of the reminder-volume metric for the hour
   before and the hour after.

Record these in
[`docs/reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md)
under "Tenant-by-tenant feature-flag cutover".
