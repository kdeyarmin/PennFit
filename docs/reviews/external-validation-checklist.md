# External validation checklist

**One tracked list of everything this repository cannot prove about
itself.**

Every item below needs a real counterparty — a warehouse, a
manufacturer, a person's face, a telephone, a clearinghouse — and no
amount of code, fixtures or test coverage can substitute for it. The
harness for each one is built, tested and documented; what is missing is
the evidence.

## The rule this list exists to enforce

A fixture-tested connector is **not** production validated. Neither is a
connector with a green unit suite, a passing schema check, or a
successful call against a mock. The only thing that supports a
"validated" claim is a record of a real exchange with the real
counterparty, retained where somebody else can find it.

Nothing in this repository may be labelled Production Validated,
Physical Validation Passed, or Live Validated until the corresponding
row here says **Passed** with its evidence attached. Two enforcement
points already exist in code:

- `integration_connector_status.status = 'live_validated'` carries a
  DB-level CHECK requiring `last_validation_success_at` — the status
  cannot be set without a timestamp from a real call.
- The fitter device matrix in
  [`../runbooks/fitter-device-validation.md`](../runbooks/fitter-device-validation.md)
  ships with every row marked "not run", and its release gate refuses to
  read as passed while any row is.

## Status legend

| Status          | Means                                                         |
| --------------- | ------------------------------------------------------------- |
| **Not started** | Nobody has attempted it.                                      |
| **Blocked**     | Attempted; waiting on a counterparty, a credential or access. |
| **Passed**      | Performed, and the evidence below is retained.                |
| **Failed**      | Performed and did not pass. The finding is open.              |

---

## 1. PacWare shipment-confirmation file (live)

| Field           | Value                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| **Status**      | **Not started**                                                                                          |
| **Who**         | The tenant's billing/warehouse operator, with an engineer observing the first run.                       |
| **Environment** | A non-production environment holding non-production data, or production in **preview mode only**.        |
| **Runbook**     | [`../integrations/pacware-shipment-confirmations.md`](../integrations/pacware-shipment-confirmations.md) |

**Why code cannot close this.** PacWare is a legacy desktop billing
system with no API. Every column name, date format and encoding in the
importer was derived from a report _specification_, not from a file the
system actually produced. The classifier, the date validation and the
matcher are all exercised against fixtures built to that specification —
which is exactly the assumption a real export is most likely to break.

**Steps**

1. Export a real shipment-confirmation report from PacWare.
2. Run the offline validator, which reads the file in place and touches
   no database and no network:
   `pnpm --filter @workspace/scripts pacware:validate-shipments -- <path>`
3. Run a **preview** import at `/admin/pacware`. Preview writes nothing.
4. Download all disposition reports and read the ambiguous and unmatched
   ones before committing anything.
5. Commit only when the matched count is what the operator expects.

**Evidence to retain**

- The validator's console output (counts and categories only — it prints
  no cell values).
- The preview import's disposition summary.
- The downloaded ambiguous/unmatched CSVs, or a note that both were empty.
- The committed import's `pacware_shipment_imports` row id.
- A note of any column whose real name differed from the specification.

---

## 2. ResMed AirView connector (live)

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Status**      | **Not started**                                                                          |
| **Who**         | An engineer with vendor sandbox credentials.                                             |
| **Environment** | Vendor sandbox. `DEPLOY_ENV` must not be `production`.                                   |
| **Runbook**     | [`../runbooks/therapy-partner-onboarding.md`](../runbooks/therapy-partner-onboarding.md) |

**Why code cannot close this.** The adapter's error classification,
pagination handling and schema mapping are all tested against recorded
shapes. A vendor's real 403-vs-401 behaviour, its real pagination cursor
semantics and its real optional-field nullability are precisely what a
fixture cannot tell you.

**Steps**

1. Set the vendor credentials in a non-production environment.
2. Run the nine-step validator from `/admin/integrations`, or the opt-in
   live suite: `INTEGRATION_LIVE_TESTS=1 pnpm --filter
@workspace/resupply-api test -- live-connection.live`. It **skips
   visibly** rather than passing when credentials are absent, and refuses
   to run at all when `DEPLOY_ENV=production`.
3. Run a portal reconciliation against a vendor export for the same window.

**Evidence to retain**

- The nine-step validator result (each step pass / fail / skipped /
  not-supported / no-data).
- The `integration_connector_status` row showing
  `last_validation_success_at` and the vendor API version.
- The reconciliation run id and its four discrepancy counts.
- The vendor's own confirmation that the account is entitled to every
  resource the adapter requests.
- A note of any field whose real nullability differed from the schema.

---

## 3. Philips Care Orchestrator connector (live)

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Status**      | **Not started**                                                                          |
| **Who**         | An engineer with vendor sandbox credentials.                                             |
| **Environment** | Vendor sandbox. `DEPLOY_ENV` must not be `production`.                                   |
| **Runbook**     | [`../runbooks/therapy-partner-onboarding.md`](../runbooks/therapy-partner-onboarding.md) |

Same procedure and same evidence as row 2. Kept as its own row because
each vendor's answer is its own fact: a passing AirView validation says
nothing about Care Orchestrator.

---

## 4. React Health (3B Medical) connector (live)

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Status**      | **Not started**                                                                          |
| **Who**         | An engineer with vendor sandbox credentials.                                             |
| **Environment** | Vendor sandbox. `DEPLOY_ENV` must not be `production`.                                   |
| **Runbook**     | [`../runbooks/therapy-partner-onboarding.md`](../runbooks/therapy-partner-onboarding.md) |

Same procedure and same evidence as row 2.

---

## 5. Physical-device fitter validation

| Field           | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| **Status**      | **Not started** — every row of the device matrix is marked "not run".                |
| **Who**         | A person with the listed devices, in front of the diagnostic page.                   |
| **Environment** | A dev build. The diagnostic page is excluded from production bundles.                |
| **Runbook**     | [`../runbooks/fitter-device-validation.md`](../runbooks/fitter-device-validation.md) |

**Why code cannot close this.** The pose diagnostic's mocked matrix
suite proves the _interpretation_ of a transformation matrix is correct
for nine cases including a reversed convention. It cannot prove that a
particular phone, running a particular browser, on a particular
front-facing camera, produces the convention we think it does. That is a
property of the device, and only a device can answer it.

**Steps**

1. Open `/internal/pose-diagnostics` on the device (dev build only).
2. Run the seven-step guided sequence: level, chin up, chin down, turn
   left, turn right, roll left, roll right.
3. Read the per-step verdict. `reversed` on any axis is a finding, not a
   pass.
4. Export the CSV. It carries derived angles only — no image is captured
   or retained at any point, and there is no code path that would.

**Evidence to retain**

- The exported CSV per device.
- The device matrix row filled in: device, OS version, browser, camera,
  per-axis verdict.
- The date and the person who ran it.

**Do not** adjust any clinical sizing threshold to make a device pass.
A device that disagrees is evidence about the device.

---

## 6. Tenant A inbound voice call

| Field           | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| **Status**      | **Not started**                                                                      |
| **Who**         | An operator with access to tenant A's published number.                              |
| **Environment** | Whichever environment owns that DID. Use a **staff** handset.                        |
| **Runbook**     | [`../runbooks/voice-inbound-validation.md`](../runbooks/voice-inbound-validation.md) |

**Why code cannot close this.** The attribution suite proves the
resolver answers correctly for two tenants, for the same DID split
across channels, and fails closed on an ambiguous caller — deterministically,
with no telephone. What it cannot prove is that the carrier is actually
delivering that DID to this deployment with the `To` header the resolver
expects.

**Steps**

1. Call tenant A's published number from a staff handset.
2. Confirm the greeting names **tenant A's** brand.
3. Confirm the resulting `voice_calls` row carries tenant A's `org_id`.
4. Confirm the conversation appears in tenant A's console and in no
   other tenant's.

**Evidence to retain**

- The call SID and the timestamp.
- A screenshot of the conversation in tenant A's console.
- The `voice_calls` row's `org_id`.
- Confirmation that `voice_calls_unattributed` did not increase.

**Do not place this call to a patient.** Use a staff handset.

---

## 7. Tenant B inbound voice call

| Field           | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| **Status**      | **Not started**                                                                      |
| **Who**         | An operator with access to tenant B's published number.                              |
| **Environment** | Whichever environment owns that DID. Use a **staff** handset.                        |
| **Runbook**     | [`../runbooks/voice-inbound-validation.md`](../runbooks/voice-inbound-validation.md) |

Same procedure and evidence as row 6, on a **different tenant's DID**.

Kept as its own row because the single most valuable fact here is the
_contrast_: tenant A's call reaching tenant A and tenant B's call
reaching tenant B, on the same deployment, at the same time. One call
proves the wiring exists; two prove it discriminates.

---

## 8. Clearinghouse sandbox order-to-cash round trip

| Field           | Value                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| **Status**      | **Not started**                                                                                      |
| **Who**         | A biller with Office Ally **sandbox** credentials.                                                   |
| **Environment** | Non-production, with synthetic patients and synthetic claims only.                                   |
| **Runbook**     | [`../runbooks/order-to-cash-sandbox-smoke-test.md`](../runbooks/order-to-cash-sandbox-smoke-test.md) |

**Why code cannot close this.** The deterministic end-to-end suite runs
the whole lifecycle through the real 837P builder and the real 277CA and
835 parsers. It proves our files are well-formed by our own reading of
the specification. Only a clearinghouse can tell you whether _its_
reading agrees.

**Steps**

1. Run in **stub mode** first (`OFFICE_ALLY_STUB=1`), which writes the
   837P to a directory instead of uploading it. Inspect the file.
2. Then run against the sandbox with synthetic patients.
3. Include a deliberate **rejection** case. A round trip that only ever
   succeeds has not tested the branch that matters most — a 277CA
   rejection must come back as `rejected`, never as a payer denial.
4. Confirm the ERA reconciles and that a partial payment lands as
   `partially_paid`, distinct from `paid`.

**Evidence to retain**

- The stub-mode 837P file.
- The sandbox submission id and the 999/277CA responses.
- The rejection case's resulting claim status.
- The 835 and the reconciled claim, showing `partially_paid` where
  applicable.
- Confirmation that the order-outcomes report counts each case in the
  bucket it belongs to.

**Never transmit a real claim for a real patient as part of this.**

---

## 9. Per-tenant lifecycle feature-flag cutover

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Status**      | **Not started** for every tenant.                                                        |
| **Who**         | The tenant's owner or an operator with `admin.tools.manage`.                             |
| **Environment** | The tenant's own, one tenant at a time.                                                  |
| **Runbook**     | [`../runbooks/resupply-lifecycle-cutover.md`](../runbooks/resupply-lifecycle-cutover.md) |

**Why this is per tenant and never global.** `resupply.due_at_authoritative`
and `resupply.ship_evidence_required` change how cycles close and how
claims are dated. Their correct setting depends on that tenant's data —
whether its due dates agree with its shipment evidence, whether it has a
shipment feed at all. A migration that enabled either globally would
shift every tenant's ladder at once on unexamined data, which is why no
migration does.

**Steps, per tenant**

1. Run the readiness assessment. It is **read-only** and can be run as
   often as you like: `pnpm --filter @workspace/scripts resupply:cutover
-- --org=<id>`
2. Read the blockers. Enabling is refused while any is unresolved, and a
   truncated assessment counts as a blocker — an incomplete survey is not
   a passing one.
3. Enable from `/admin/resupply-cutover` with an explicit confirmation
   and an evidence identifier. The readiness check is **re-run at enable
   time**, so a stale pass cannot authorise a flip.
4. Watch the `flags_without_readiness_evidence` signal. A flag on with no
   current assessment is a critical alert.
5. Readiness expires after 14 days. `validation_expired` means re-assess,
   not assume.

**Evidence to retain, per tenant**

- The assessment report (all metrics, including truncation).
- The `resupply_cutover_records` row: org, flag, previous value, new
  value, actor, timestamp, readiness result, evidence identifier.
- For a rollback: the row, and its reason (rollback is deliberately NOT
  gated on a passing assessment — it must always be available).

**Tenant tracker**

| Tenant                   | `due_at_authoritative` | `ship_evidence_required` | Assessed | Evidence |
| ------------------------ | ---------------------- | ------------------------ | -------- | -------- |
| Penn Home Medical Supply | Not started            | Not started              | —        | —        |

Add a row per tenant as they are onboarded.

---

## Summary

| #   | Item                                | Status      |
| --- | ----------------------------------- | ----------- |
| 1   | PacWare shipment-confirmation file  | Not started |
| 2   | ResMed AirView connector            | Not started |
| 3   | Philips Care Orchestrator connector | Not started |
| 4   | React Health connector              | Not started |
| 5   | Physical-device fitter validation   | Not started |
| 6   | Tenant A inbound voice call         | Not started |
| 7   | Tenant B inbound voice call         | Not started |
| 8   | Clearinghouse sandbox order-to-cash | Not started |
| 9   | Per-tenant lifecycle flag cutover   | Not started |

**Nine of nine outstanding.** The system is not production-validated, and
nothing in this repository claims it is.
