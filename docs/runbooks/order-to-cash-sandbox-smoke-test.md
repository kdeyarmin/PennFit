# Runbook — order-to-cash smoke test in a clearinghouse sandbox

**Owner:** the biller, with the operator who holds the Office Ally
credentials.
**Status: NOT PERFORMED.** No claim has been sent to any clearinghouse,
sandbox or otherwise, from this codebase.

---

## What is already proven, and what is not

**Deterministically, in CI** — `src/lib/analytics/order-to-cash.e2e.test.ts`
walks a synthetic patient from eligible to paid through the _real_
modules (the episode closure builder, the 837P builder, the 277CA and 835
parsers, the outcome funnel) and covers thirty branches: never contacted,
no response, declined, opted out, address hold, confirmed-not-fulfilled,
assumed-shipped, shipped-not-billed, draft, submitting, clearinghouse
rejection, clearinghouse acceptance, payer denial with and without a CARC
code, partial payment, full payment, secondary/COB, duplicate and
corrected shipment evidence, cancelled fulfillment, and two cross-tenant
attempts.

**What that cannot prove** is that a _real_ clearinghouse accepts the
bytes. Office Ally's intake is stricter than any parser here: it validates
loop cardinality, segment order, ISA byte offsets, and payer-specific
companion-guide rules that are not published in the X12 standard. The
only way to learn that is to send one.

---

## Before anything is sent

`OFFICE_ALLY_STUB=1` (or missing credentials) writes the 837P to
`OFFICE_ALLY_FILE_OUTBOX_DIR` instead of uploading. **Start there.**

```bash
OFFICE_ALLY_STUB=1 OFFICE_ALLY_FILE_OUTBOX_DIR=/tmp/oa-outbox \
  pnpm --filter @workspace/resupply-api dev
```

Create a claim for a synthetic patient in a non-production tenant, submit
it, and read the file. Check by eye:

- `ISA` is exactly **106 bytes**, with the component separator at offset 104. Office Ally parses this segment by byte offset; a short sender id
  that is not space-padded shifts every later byte and makes the whole
  interchange unparseable at intake.
- `GS08` and `ST03` both read `005010X222A1`.
- `CLM01` is the internal claim id — the join key the 277CA echoes back
  as its trace number, and the 835 echoes back as `CLP01`.
- `DTP*472` (date of service) is the **shipment** date, not today's.

---

## The sandbox test

| #   | Step                                                                                  | Who      | Expected                                                                                                      |
| --- | ------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Confirm the credentials are a **sandbox/test** account and `usageIndicator` is `T`    | Operator | A test interchange, never `P`                                                                                 |
| 2   | Create one claim for a **synthetic** patient with a real HCPCS and a sandbox payer id | Biller   | A draft claim                                                                                                 |
| 3   | Submit it                                                                             | Biller   | The claim leaves `draft`; a submission row records who sent it                                                |
| 4   | Wait for the **999**                                                                  | —        | Syntactically accepted. A 999 rejection is a malformed interchange — fix and resend; nothing reached a payer. |
| 5   | Wait for the **277CA**                                                                | —        | `outcome: accepted`, with the trace number matching `CLM01`                                                   |
| 6   | Wait for the **835**                                                                  | —        | A remit citing the same control number                                                                        |
| 7   | Check `/admin/analytics/order-outcomes`                                               | Biller   | The synthetic episode moves through claimed → accepted → paid                                                 |

### Then deliberately produce a rejection

The distinction between a rejection and a denial is the single most
consequential classification in this pipeline, and it is worth seeing
once with real bytes.

Submit a claim with a **member id the sandbox does not recognise**. Expect
a 277CA with STC category `A3`, parsed as `rejected`.

**Verify it is NOT recorded as a denial.** A rejection means the claim was
malformed and never reached adjudication; a denial means the payer
considered it and said no. Sending a biller to appeal a rejection wastes
the appeal and burns the timely-filing clock.

| Where                             | Expected                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| `insurance_claims.status`         | `rejected`, not `denied`                                           |
| `/admin/analytics/order-outcomes` | `postShipLoss.rejected` increments; `postShipLoss.denied` does not |
| CARC breakdown                    | Unchanged — a rejection has no CARC code                           |
| Denials worklist                  | The claim does **not** appear                                      |

---

## Rules that hold in the sandbox too

- **Never `usageIndicator: "P"`** during a smoke test.
- **Synthetic patients only.** A real member id in a sandbox is still a
  real member id leaving the building.
- **Never auto-submit during the test.** `billing.auto_submit_claims`
  stays off; every submission is a deliberate click, so the test measures
  the pipeline rather than the worker.
- **One claim at a time.** A batch that fails at intake fails as a batch,
  and you learn one thing instead of several.

---

## Evidence to retain

1. The stub-mode 837P file (synthetic — safe to attach).
2. The 999, 277CA and 835 as received.
3. A screenshot of `/admin/analytics/order-outcomes` before and after.
4. For the rejection case: the claim row showing `rejected`, and the
   denials worklist **not** containing it.

Record in
[`../reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md).
Until these exist, the honest statement is "the pipeline is
deterministically tested end to end; no claim has been sent to a
clearinghouse."

---

## Related

- [`office-ally-go-live.md`](./office-ally-go-live.md)
- [`../reviews/order-outcomes.md`](../reviews/order-outcomes.md) — every
  stage and denominator
