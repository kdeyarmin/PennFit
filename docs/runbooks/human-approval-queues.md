# Runbook — the human-approval queues ("Needs a person")

**Owner:** the practice owner, and the role named on each gate.
**Surface:** `GET /resupply-api/admin/approval-gates`, rendered on
`/admin/operations`.

---

## What this is, and what it is not

Every transition in this platform that a person has to make, stated once,
with a live count, an age, and the reason a person is required.

**It changes no gate.** It is read-only. Adding an entry to the registry
does not create a control; removing one does not open anything. If you
change what a gate does, change it at its own site and update the entry
to match.

The posture it describes is deliberate and stated at each site
(`auto-workflow-engine.ts`: "we never auto-SUBMIT";
`secondary-claim-generator.ts`: the same rule restated;
`billing-action-queue.ts`: "a deliberate human click"). It was stated in
about a dozen places and nowhere as a set — so an operator could not see
what was waiting on them without opening a dozen queues and knowing which
ones existed, and nobody could check whether the product's description of
itself was still true.

---

## Reading a row

| Field               | Meaning                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `waiting`           | How many items. `null` means the count could not be taken **or** this gate has no single queue — the next two fields disambiguate. |
| `countable`         | Whether this gate has a queue **at all**. A static property of the registry, not of this request.                                  |
| `countFailed`       | The read itself failed. **An outage signal**, not an empty queue.                                                                  |
| `uncountableReason` | Why no count is possible, for `countable: false`. Present so a permanent dash is informative rather than alarming.                 |
| `oldestAgeHours`    | How long the oldest item has been waiting.                                                                                         |
| `ageStatus`         | `ok` · `due_soon` · `breached` · `escalate` · `no_sla` · `unknown`                                                                 |
| `partlyAutomated`   | A worker moves part of this queue for this tenant, so `waiting` is a **ceiling**, not a backlog.                                   |
| `priority`          | 1 works first. Ordered by what breaks if it does not.                                                                              |
| `disposition`       | Where the decision is recorded once made.                                                                                          |
| `refreshedAt`       | When the reading was taken (top level).                                                                                            |

### Four states that all look like zero if you let them

This is the distinction the panel exists to preserve:

| Appearance              | Reality                      | Response                                      |
| ----------------------- | ---------------------------- | --------------------------------------------- |
| `waiting: 0`            | Genuinely empty              | Nothing                                       |
| `countable: false`      | No single queue, permanently | Read `uncountableReason`; use the linked page |
| `countFailed: true`     | The read failed **just now** | Come back; check `/readyz` if it persists     |
| `partlyAutomated: true` | Part moves without a person  | Treat the number as an upper bound            |

**A backlog rendering as a quiet day is the specific failure this
prevents.** A count that fails drops OUT of the total rather than
entering it as a zero, so an operator watching the sum sees it fall and
the failure counter rise together.

### Why an age and not just a count

Five items sitting for six weeks and fifty that arrived this morning are
different problems, and only the first is failing anybody. Expectations
are per gate because they are not comparable — a patient waiting on an
address confirmation is blocking a shipment today; a catalog sign-off is
a standing task with **no** SLA at all, and giving it one would
manufacture an alarm.

`escalate` is `breached` past a multiplier (default **3×**,
`APPROVAL_GATE_ESCALATION_MULTIPLIER`, read per request so a change needs
no deploy). Past the SLA is _late_. Past the multiplier is _nobody is
working this_, and those want different responses.

---

## The gates

### Priority 1 — a patient is waiting on this today

| Gate                                     | Owner | SLA | Where                    |
| ---------------------------------------- | ----- | --- | ------------------------ |
| Work a mask-fitter request               | CSR   | 24h | `/admin/fitter-requests` |
| Confirm a patient's new shipping address | CSR   | 24h | `/admin/alerts`          |
| Record that an order shipped             | CSR   | 72h | `/admin/episodes`        |

**Mark shipped** is priority 1 despite the longer window because it is
load-bearing three ways: until a shipment is recorded, the patient's next
refill is timed from when the order was _queued_, their claim carries the
wrong date of service, and the cycle never closes. Prefer the PacWare
import (`/admin/pacware`) — marking by hand depends on somebody
remembering.

### Priority 2 — money and clinical review

| Gate                                         | Owner     | SLA  | Where                             |
| -------------------------------------------- | --------- | ---- | --------------------------------- |
| Approve or override a mask fitting           | Clinician | 48h  | `/admin/fit-sessions`             |
| Approve a suggested resupply order           | CSR       | 72h  | `/admin/therapy-resupply`         |
| Call a patient the reminders could not reach | CSR       | 72h  | `/admin/alerts`                   |
| Review what the claim scrubber flagged       | Biller    | 48h  | `/admin/billing/ai-queue`         |
| Create the claim for a shipped order         | Biller    | 120h | `/admin/billing`                  |
| Submit claims to the clearinghouse           | Biller    | 120h | `/admin/billing/auto-submit`      |
| Chase outstanding paperwork before billing   | Biller    | 168h | `/admin/billing/bill-hold`        |
| Work a denial                                | Biller    | 240h | `/admin/billing/denials-worklist` |

### Priority 3 — standing work

| Gate                        | Owner     | SLA  | Where                      |
| --------------------------- | --------- | ---- | -------------------------- |
| Submit a secondary claim    | Biller    | 168h | `/admin/billing/secondary` |
| Send an appeal letter       | Biller    | 240h | `/admin/billing/denials`   |
| Sign off on catalog entries | Clinician | none | `/admin/fitter/catalog`    |

---

## Responding to an escalation

1. **Read the owner, not the count.** Every gate names a role. An
   escalated queue is that role's, and reassigning it starts by knowing
   whose it was.
2. **Check `countFailed` across the panel first.** Several gates failing
   at once is an outage, not a backlog — check `/readyz`.
3. **`partlyAutomated` gates escalate differently.** The count is a
   ceiling. Before staffing a "500 claims waiting", confirm the
   auto-submit worker is running: if it is, most of that number is
   already moving.
4. **Do not close a gate by automating it.** Each `why` is the argument
   that has to survive the next person who asks "can't we automate
   this?". If the argument no longer holds, change it deliberately, at
   the gate's own site — not by widening a filter until the queue empties.

### The three gates that must never become automatic

- **Claim submission.** Unattended submission exists but needs BOTH an env
  cron and a per-tenant flag, and it only takes claims that pass preflight
  with fresh active eligibility. Everything it excludes is waiting on a
  person by design.
- **Clinical fitting review.** A recommendation from measurements is a
  starting point, not a prescription.
- **Address confirmation.** An order sent to a stale address is lost
  product and a patient without supplies.

---

## Keeping the panel honest

Two automated checks, both in `node scripts/run-resupply-checks.mjs`:

- **`check-approval-gate-links.sh`** — every gate's `href` must be a real
  SPA route. A gate that shows a number an operator cannot act on is
  worse than one that shows nothing: they click it, land on a 404, and
  they were already behind. It self-tests (a bogus href must fail).
- **`registry.completeness.test.ts`** — every gate has a unique key, an
  admin href, a permission, a >60-character `why`, a recorded
  disposition, a priority, and either an age column or a written reason
  it cannot be counted. It also asserts that **only** `claim_submit`
  carries `conditionalOn`, so a manual gate cannot quietly become
  automatic.

**PHI:** the response carries table names, statuses, counts and ages.
Nothing reaches a patient record, which is why anyone with
`reports.read` can open it.

---

## Related

- `artifacts/resupply-api/src/lib/approval-gates/registry.ts` — the set
- [`../PRODUCTION_READINESS.md`](../PRODUCTION_READINESS.md)
- [`resupply-lifecycle-cutover.md`](./resupply-lifecycle-cutover.md)
