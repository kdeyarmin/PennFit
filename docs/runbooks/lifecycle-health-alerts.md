# Runbook — lifecycle health alerts

**Audience:** whoever is answering the alert.
**Scope:** every signal in the lifecycle health catalog
(`artifacts/resupply-api/src/lib/lifecycle-health/signals.ts`).
**Related:** [`human-approval-queues.md`](./human-approval-queues.md),
[`resupply-lifecycle-cutover.md`](./resupply-lifecycle-cutover.md),
[`pacware-import-export.md`](./pacware-import-export.md),
[`therapy-partner-onboarding.md`](./therapy-partner-onboarding.md),
[`voice-inbound-validation.md`](./voice-inbound-validation.md).

Every signal below has a section here, and a spec
(`signals.test.ts`) fails the build if one loses it. An alert nobody
knows how to answer is worse than no alert: it consumes attention and
returns nothing.

---

## How the monitor works

A pg-boss job — `lifecycle.health-scan`, every two hours at :20 — measures
every signal for every active tenant, plus two platform-scope signals about
rows that belong to no tenant at all. It **changes nothing**: no cycle
closes, no flag flips, no patient is contacted. Its only writes are to its
own two tables.

The same collectors and the same evaluator back the live panel at
`GET /resupply-api/admin/lifecycle-health`, so the page and the alert cannot
disagree about a number.

### The six states, and why four of them are not "ok"

| State            | Means                                                                                                                          | Act?                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `ok`             | Measured, inside threshold.                                                                                                    | No                           |
| `warning`        | Past the warn threshold.                                                                                                       | Soon                         |
| `failure`        | Past the fail threshold.                                                                                                       | Now                          |
| `disabled`       | This tenant does not use the feature. Nothing to measure and nothing wrong.                                                    | No                           |
| `not_configured` | The feature exists but nothing is set up, so the true value is **unknown**. Reporting zero would be a claim we cannot support. | Sometimes — see the signal   |
| `unknown`        | The read failed. An outage **in the monitor**, not a quiet day in the business.                                                | Yes, investigate the monitor |

An `unknown` never resolves an open alert. A read that failed is not
evidence that a problem went away.

### Thresholds

Every signal reads `LIFECYCLE_HEALTH_<KEY>_WARN` and `_FAIL` from the
environment and falls back to a default. Tune them — the defaults are
sized for a mid-size DME and are meant to be arguable. A malformed value
falls back to the default and the panel reports `thresholdSource:
"default_after_invalid_env"`, so a variable that did not take is visible
rather than silently ignored.

The quiet window between repeat notifications for an unchanged problem is
`LIFECYCLE_HEALTH_RENOTIFY_HOURS` (default 24).

**The quiet window is earned by a delivered digest, not by an attempt to
send one.** `last_notified_at` — the column that suppresses the next 24
hours — is stamped only after a send is confirmed. If email is
unconfigured, the recipient list is empty, or SendGrid rejects the
message, the alert stays unstamped and the very next scan reports it
again. So a mail outage costs one scan interval of delay, never a silent
day.

### How often you hear from it

At most **one message per tenant per scan**, plus at most one for the
platform scope. A brand-new problem notifies; a problem that got worse
notifies; an unchanged problem notifies at most once a day; a problem that
fixed itself notifies once and stops. Signals are aggregate — counts, ages
and ratios over populations — so there is no per-patient alert anywhere in
this subsystem and no way to introduce one without changing what a signal
is.

### First moves for ANY alert

1. Open `/admin/operations` and read the panel. The alert is a snapshot;
   the panel is live.
2. Check `truncated` on the row. If it is set, the number is a **floor**
   and the real one is larger.
3. Check `lastScanAgeHours`. If the background scan has not reported for
   hours, treat the whole panel as suspect and start at
   **[Dead-lettered worker jobs](#dead-lettered-worker-jobs)** — which is
   platform-scoped, so read it from the operator digest rather than from a
   tenant's panel.
4. Check whether the same signal is firing for other tenants. One tenant
   is a tenant problem; every tenant is a platform problem.

---

## Intake

### Cycle-creation spike

**Severity:** major · **Unit:** multiple of the trailing 14-day daily average

A spike is almost never demand.

1. `/admin/episodes`, sorted newest first. Look at the created timestamps:
   a sweep re-running produces a dense cluster within minutes, real demand
   does not.
2. If they cluster, check the worker log for repeated
   `resupply.cycle-sweep` runs in the same window and for a redelivered
   pg-boss job.
3. If they are spread out, check whether a cadence was edited — a
   `frequency_rules` change or a bulk `cadence_override_days` import will
   make a large population due at once.
4. **Do not mass-close episodes to make the number go down.** Each one may
   already have contacted a patient. Stop the producer first, then work the
   duplicates through `/admin/episodes` with a CSR cancel, which records a
   reason.

**Evidence to keep:** the created-at histogram, the worker log lines, and
the config change (if any) that caused it.

### No cycles created

**Severity:** critical · **Unit:** hours since the last cycle was created

A stalled sweep is silent by nature: nothing errors, patients simply stop
being contacted, and the business effect arrives a month later.

1. Confirm the tenant genuinely has an eligible population — the signal
   reports `disabled` when it has no active prescriptions, so if you are
   seeing a number there are patients waiting.
2. Check `worker_failures`. A dead-lettered `resupply.cycle-sweep` is the
   most common cause.
3. Check the worker log for `resupply.cycle-sweep` completions. Absent
   entirely → the worker is not running or the schedule was lost; run the
   liveness probe `/resupply-api/healthz` and check `/readyz` for worker
   readiness.
4. Present but producing zero → look at the sweep's own filters: an
   expired prescription window, or every candidate already holding an open
   episode.

**Do not** hand-create cycles to clear the alert. Fix the producer; the
sweep is idempotent and will catch up.

### Open cycles past their expiry

**Severity:** major · **Unit:** count

The expiry sweep should close these daily and open the next cycle. A
growing number means it is not running — and every patient in it is stuck
out of resupply rather than being asked again.

1. Check `worker_failures` for a dead-lettered `resupply.cycle-sweep`.
2. Check that `expires_at` is actually stamped on new episodes (migration
   0538 backfilled the old ones and `openOutreachEpisode` stamps new ones).
   A NULL `expires_at` is invisible to the sweep and to this signal.
3. Once the sweep runs, the number drains on its own. It does not need
   manual closing.

---

## Outreach

### Cycles closed never-contacted

**Severity:** critical · **Unit:** count over 7 days

**This is not a patient decision and must never be read as one.** These
patients went without supplies while the system recorded a normal-looking
close.

1. `/admin/analytics/order-outcomes` → the pre-ship loss breakdown. Compare
   `never_contacted` against `no_response`: a rise in the first with the
   second flat is an outreach outage, not a messaging-effectiveness problem.
2. Check the delivery-failure monitor and `/admin/delivery-failures`. A
   Twilio or SendGrid outage during the window shows here.
3. Check the affected patients' contact data — a bulk import that landed
   without phone numbers produces exactly this shape.
4. Check quiet-hours configuration. A tenant whose quiet hours cover the
   whole day contacts nobody and errors nowhere.

**Recovery:** these cycles are closed. Re-opening them is a deliberate
outreach decision made at `/admin/episodes`, not an automatic repair — and
it re-contacts real people, so it is the tenant's call.

### Cycles closed with no response

**Severity:** major · **Unit:** count over 7 days

Distinct from never-contacted: these patients were reached and did not
answer.

1. Compare channels at `/admin/analytics/channel-engagement`. One channel
   collapsing is a deliverability problem; all channels drifting together
   is a messaging or timing problem.
2. Check send times against the tenant's population.
3. Check whether the message copy changed recently.

This one is a tuning problem, not an outage. Do not escalate it as one.

### Address holds past SLA

**Severity:** major · **Unit:** count

The patient has already said yes. The shipment is blocked on someone
confirming where it goes, and every hour here is a day added to a reorder
the patient believes is on its way.

1. `/admin/episodes?status=address_hold`, oldest first.
2. Work them. This queue has no automation by design — see
   [`human-approval-queues.md`](./human-approval-queues.md).
3. If the queue is large and growing, the cause is usually staffing, not
   software. Say so plainly rather than raising the threshold.

The SLA comes from the `address_change_confirm` approval gate, so it is the
same number the "Needs a person" panel uses.

---

## Fulfillment

### Cycles advanced without shipment evidence

**Severity:** critical · **Unit:** count over 7 days

These are **neither shipped nor lost**. The grace sweep deliberately never
invents a ship date, so nobody knows whether anything left the warehouse.
This bucket is exactly the population the platform cannot account for.

1. Ask whether this tenant has a shipment-confirmation feed at all. If
   `pacware_unmatched_rows` reports `not_configured`, it does not — and the
   fix is to connect one, not to tune this threshold.
2. If a feed exists, this signal rising means evidence is arriving **later
   than the grace window** (`RESUPPLY_SHIP_EVIDENCE_GRACE_DAYS`, default 14).
   Read `shipment_evidence_lag` next.
3. **Never** back-fill a ship date to clear this. A ship date becomes the
   date of service on an 837P; inventing one is a compliance problem, not a
   data-quality one.

**Evidence to keep:** the count over time. A tenant that connects a feed
watches this bucket collapse, and that collapse is the argument for the
work.

### Shipment-evidence lag

**Severity:** major · **Unit:** hours from queue to confirmed shipment

1. `/admin/pacware`. When was the last shipment-confirmation import?
2. If imports are regular but the lag is long, the delay is upstream in the
   warehouse or in the report's own generation cadence.
3. If imports are irregular, that is the fix — a daily import makes this
   number a day.

Past the grace window (336h by default) evidence is arriving too late to be
used at all, and cycles are advancing as assumed-shipped instead.

### Queued and never shipped

**Severity:** critical · **Unit:** count older than 7 days

Either the warehouse has a backlog nobody is watching, or shipments are
happening and the confirmation feed is not reaching us. Both are expensive
and they look identical from here.

1. `/admin/fulfillments`, filtered to queued, oldest first.
2. Pick three and check them against the warehouse's own record. If the
   warehouse shipped them, this is a feed problem — go to
   **[PacWare rows that matched nothing](#pacware-rows-that-matched-nothing)**.
3. If the warehouse did not ship them, this is an operations backlog. It is
   real, and the number is the correct one to escalate.

### PacWare rows that matched nothing

**Severity:** major · **Unit:** count in the most recent committed import

Each one is a shipment the warehouse believes it sent and this system has
no record of, so the cycle stays open and the claim never starts.

1. `/admin/pacware` → the import's downloadable unmatched report.
2. The usual causes: a patient who exists in PacWare but not here (run the
   patient import first), a SKU that does not match the catalog, or a ship
   date outside the matcher's window.
3. Fix the underlying record, then re-import. The importer is idempotent by
   file hash, so a re-import of an unchanged file is refused rather than
   double-applied — acknowledge the re-import deliberately when the fix
   required editing the file.

### PacWare ambiguous rows

**Severity:** critical · **Unit:** count in the most recent committed import

The importer refuses to guess: a wrong match writes a wrong date of service
onto a claim. These are held for a person and stay held.

1. `/admin/pacware` → the ambiguous report. Each row names the candidate
   fulfillments and why they could not be told apart.
2. Resolve each one against the warehouse's own order reference.
3. The permanent fix is `pacware_order_ref` on the fulfillment — once
   stamped, matching is an index probe rather than a patient+SKU+date
   search, and ambiguity stops occurring.

The warn threshold is **one**, deliberately.

### PacWare rows with unusable dates

**Severity:** major · **Unit:** count in the most recent committed import

1. A **future-dated** ship is almost always a spreadsheet re-formatting the
   column. Re-export as text and re-import.
2. An **implausibly old** ship is almost always a re-export of last year's
   file. Check the report's own date range before re-importing.
3. An **unparseable** date is a locale problem (DD/MM vs MM/DD). The data
   dictionary in
   [`pacware-shipment-confirmations.md`](../integrations/pacware-shipment-confirmations.md)
   names the accepted formats.

None of these may become a date of service.

---

## Billing

### Shipped and never billed

**Severity:** critical · **Unit:** count shipped 7–45 days ago with no claim

Usually the single largest recoverable number on the panel and the one
nothing else surfaces: it does not appear in denials, it does not appear in
rejections, and the cycle looks successfully completed.

1. `/admin/claims`. Compare the claim count for the window against the
   shipped count the panel reports.
2. Check the claim-draft producer: `billing.auto-workflow` and the
   prescription/eligibility preconditions it requires. A tenant whose
   eligibility checks are failing produces no drafts and no errors.
3. Check `worker_failures` for a dead-lettered billing job.
4. Work the backlog through the normal claim path. **Do not** bulk-submit
   to clear the number — every claim still needs its approval gate.

**Evidence to keep:** the count, and the dollar value of the window, so the
recovery is measurable.

### Claims stuck submitting

**Severity:** critical · **Unit:** count older than 2 hours

`submitting` means a batch upload started and never reported back. The
claim is in an **unknown state** with the clearinghouse.

1. **Do not resubmit blindly.** A duplicate claim is worse than a late one.
2. Check the Office Ally outbox and the SFTP transfer log for the batch.
3. If the file was delivered, wait for the 999/277CA; the status resolves
   on acknowledgement.
4. If the file was not delivered, the claim can be re-queued. The
   `claims-submitting-watchdog` job does this within its own bounds — check
   its log before acting by hand.

### Claims without shipment evidence

**Severity:** critical · **Unit:** count over 30 days

Reported as `disabled` for tenants that have not enabled
`resupply.ship_evidence_required`.

A claim whose date of service is not anchored to an actual shipment is a
compliance problem, not a data-quality one.

1. Identify the claims. Each one either has no fulfillment at all, or a
   fulfillment with no `shipped_at`.
2. **Do not** set a ship date to satisfy the check. Find the evidence — the
   PacWare confirmation, the carrier record — and record it through the
   normal import, which writes it through the single canonical path.
3. If the evidence does not exist, the claim should not have been raised.
   Escalate to whoever approved it.

### Clearinghouse rejection rate

**Severity:** major · **Unit:** share of claims over 30 days

A rejection is a **structural** refusal: the claim never reached the payer.
It is fixable and resubmittable, and it must never be counted as a payer
denial.

1. `/admin/claims?status=rejected`. Group by payer — a rising rate is
   usually one payer's requirements changing, not a general regression.
2. Read the 277CA status messages. They name the segment at fault.
3. Fix the claim data or the payer profile, then resubmit.

### Payer denial rate

**Severity:** major · **Unit:** share of adjudicated claims over 30 days

Unlike a rejection this one reached the payer and lost on its merits, so
the fix is upstream in eligibility and documentation.

1. `/admin/analytics/order-outcomes` → the CARC breakdown.
2. Timely filing (CARC 29) points at the shipped-and-never-billed backlog.
3. Medical necessity and coverage codes point at eligibility verification
   and the documentation attached before submission.

---

## Integrations

### Manufacturer connector failures

**Severity:** major · **Unit:** highest consecutive-failure count

Reported as `not_configured` — never zero — when no connector is set up.

1. `/admin/integrations`. Read the connector's `last_error_category`.
2. **`configuration`** (unauthorized, forbidden, endpoint not found):
   retrying will not help. For `forbidden` specifically, **do not rotate
   the secret** — the credential authenticated and was refused, so the
   problem is entitlement, not the key.
3. **`transient`** (timeout, server error): the circuit breaker has already
   backed off. Confirm with the vendor's status page before escalating.
4. **`no_data`**: the connection works and the window was empty. Not a
   failure.
5. Re-run the connector validator from `/admin/integrations` once the cause
   is addressed; it walks the nine steps and names the one that fails.

### Connectors returning partial data

**Severity:** major · **Unit:** count of connectors

A partial response looks like a successful sync from the outside, and the
missing half quietly becomes a gap in every downstream adherence number.

1. `/admin/integrations` → the connector's `partial_resources` list names
   which resources failed.
2. A resource that is consistently missing is usually an entitlement the
   vendor has not granted for this account — same posture as `forbidden`.
3. Do not treat a partial sync as a successful one when judging compliance:
   the adherence numbers for the affected window are incomplete.

### Portal reconciliation discrepancies

**Severity:** major · **Unit:** count from the most recent run per source

Reported as `not_configured` when no reconciliation has ever been run.
**Never having checked is not the same as having checked and found
nothing** — and this is the only signal that can tell you the therapy data
is quietly wrong rather than quietly absent.

1. `/admin/integrations` → the reconciliation report for the source.
2. **Missing locally** — patients in the vendor's portal that we do not
   have. Usually an enrollment that never reached us.
3. **Missing in portal** — patients we hold that the vendor does not.
   Usually a stale enrollment on our side.
4. **Mismatched** — the same patient with different figures. This is the
   one that makes adherence decisions wrong; investigate before trusting
   the window.

### Therapy data staleness

**Severity:** major · **Unit:** hours since the last successful sync

Stale device data does not error. The adherence screens keep rendering
yesterday's numbers as though they were today's, and compliance decisions
get made on them.

1. Check `connector_failures` first — staleness is usually its symptom.
2. If the connector is healthy and the data is still stale, the nightly
   sync job is not running: check `worker_failures`.

---

## Tenancy

### Voice calls with no tenant

**Severity:** critical · **Unit:** count over 7 days · **Platform scope**

Such a call belongs to no practice: it is invisible in every tenant's
metrics and its conversation cannot be worked by anyone.

1. `/admin/phone-settings`. Find a DID that is pointed at the platform but
   not registered to a tenant — that is the usual cause.
2. Register it to its owning tenant. Do **not** assign the orphaned calls
   to a tenant by hand unless you can establish ownership from the dialled
   number; recency of contact is not evidence of ownership.
3. Validate the fix with the simulated-inbound tool against a non-production
   host — see [`voice-inbound-validation.md`](./voice-inbound-validation.md).

One is worth investigating.

### Inbound events that failed tenant attribution

**Severity:** critical · **Unit:** count over 7 days · **Platform scope**

Dropping the event is **correct** — filing a stranger's message under the
nearest-looking practice is the isolation bug this platform refuses to have
— but a rising count means a real patient is being ignored by a real
practice's published number.

**Every one of these means nobody owns the dialled line**, on that channel
— that is what it takes to reach the caller fallback at all. So the first
fix is always the same: register the number at `/admin/phone-settings`,
remembering that SMS and voice ownership are **separate columns** (a DID
registered for texting does not answer calls).

The reason recorded is the more specific one: what the caller fallback
found once the dialled number had already come back unowned. Each needs a
different second step:

- **`unknown_called_number`** — no caller number was supplied at all, so no
  fallback was possible. The unregistered line is the whole story.
- **`unknown_caller`** — a caller number was supplied and matches no
  patient anywhere. Usually a genuine wrong number; only worth acting on in
  volume. This is the expected reason for a stranger dialling an
  unregistered line, and it is **not** an ambiguity.
- **`ambiguous_caller`** — the caller's own number exists in more than one
  tenant, so ownership is genuinely undecidable. The fix is a dedicated DID
  for that tenant, not a tie-break rule. Rare, and worth investigating even
  at one.
- **`directory_unavailable`** — the lookup itself failed. An outage: while
  it lasts, neither of the two reasons above is knowable, so do not read a
  drop in them as an improvement. This reason is deliberately **not**
  cached, so recovery is picked up on the next inbound event.

The resolver reports these; the inbound routes record what it reports. A
route that inferred the reason from what it happened to have in scope —
"a caller number was supplied, so it must be ambiguous" — would file every
ordinary wrong number under `ambiguous_caller` and send you to provision a
DID nobody needs.

The counter holds a day, a channel, a reason and a count. There is no phone
number in it and no column for one: attribution is exactly what failed, so
there is no tenant to scope a PHI-bearing row to.

### Lifecycle flags enabled without readiness evidence

**Severity:** critical · **Unit:** count of flags

The resupply lifecycle flags change how cycles close and how claims are
dated. Enabling one on unexamined data shifts a tenant's whole ladder
without anyone deciding it should.

1. `/admin/feature-flags` — confirm which flag is on.
2. Run the readiness assessment (`/admin/resupply-cutover`, or the CLI in
   [`resupply-lifecycle-cutover.md`](./resupply-lifecycle-cutover.md)). It
   is read-only.
3. If the assessment comes back **ready**, record the cutover so the
   evidence exists. If it comes back **blocked**, roll the flag back and
   work the blockers — the rollback path does not require a passing
   assessment, deliberately.
4. `validation_expired` means the evidence has aged out (14 days). Re-run
   the assessment; do not assume the old result still holds.

---

## Platform

### Human-approval queues past SLA

**Severity:** major · **Unit:** count of queues

These are the steps that deliberately do not move without a person. The
design assumes a person turns up, and this is the only thing that checks
whether one did.

1. `/admin` → the "Needs a person" panel. It names which queue and how old
   its oldest item is.
2. Work the oldest first. Priority 1 gates block a patient today.
3. `APPROVAL_GATE_ESCALATION_MULTIPLIER` (default 3) separates "late" from
   "nobody is working this". Past the multiplier, escalate to a person's
   manager rather than to the queue.

Full procedure: [`human-approval-queues.md`](./human-approval-queues.md).

### Dead-lettered worker jobs

**Severity:** critical · **Unit:** count of jobs · **Platform scope**

Nearly every signal on this panel depends on a worker: the sweeps that
close cycles, the sends that contact patients, the batches that file
claims. A dead-lettered job is a silent halt to one of them.

**Platform scope, not per tenant.** pg-boss queues are process-wide:
`getQueues()` reports one number for the whole deployment, and no dead job
can be attributed back to the tenant whose row it was working on. It is
reported once, to the platform operator on `RESUPPLY_ADMIN_EMAILS` — it
does **not** appear in a tenant's `/admin/operations` panel, which names it
under `scope.platformSignalsElsewhere` instead. If it were tenant-scoped,
one stuck job would email every practice about a queue none of them can
see or drain.

1. The daily DLQ digest names the queues. `/admin/operations` shows worker
   readiness.
2. Identify which queue. The queue name tells you which signals on this
   panel to distrust until it is drained.
3. Fix the cause before replaying: a job that exhausted its retries will
   exhaust them again.
4. **Read this one first when several signals fire at once.** A stopped
   worker produces a panel full of unrelated-looking alerts.

### Truncated analytics windows

**Severity:** major · **Unit:** count of collectors that hit their cap

Every capped read makes the number it produced a **floor** rather than a
total, so something on the panel above is understating itself.

1. The alert detail names which collectors truncated.
2. Those signals' numbers are lower bounds. Treat a `warning` from a
   truncated collector as at least a `failure` until you know otherwise.
3. Truncation on `shipped_unbilled` or `claims_missing_ship_evidence` means
   the backlog is past 5,000 rows. That is itself the finding — escalate
   the backlog, not the cap.
4. Persistent truncation on a healthy tenant means the window or the cap
   needs revisiting in
   `artifacts/resupply-api/src/lib/lifecycle-health/collect.ts`. Raising the
   cap makes the scan slower for every tenant; narrowing the window is
   usually the better answer.

---

## Configuration reference

| Variable                              | Default    | Effect                                                    |
| ------------------------------------- | ---------- | --------------------------------------------------------- |
| `LIFECYCLE_HEALTH_<SIGNAL>_WARN`      | per signal | Warn threshold. `<SIGNAL>` is the key, upper-cased.       |
| `LIFECYCLE_HEALTH_<SIGNAL>_FAIL`      | per signal | Failure threshold.                                        |
| `LIFECYCLE_HEALTH_RENOTIFY_HOURS`     | `24`       | Quiet window before an unchanged alert is repeated.       |
| `APPROVAL_GATE_ESCALATION_MULTIPLIER` | `3`        | Multiple of a queue's SLA at which it escalates.          |
| `RESUPPLY_ADMIN_EMAILS`               | —          | Digest recipients. Empty means no email is sent (logged). |

The digest also posts to Slack when `slack.digests` is enabled and a
channel is configured. Both channels are best-effort: an unconfigured
notifier degrades to a log line and never fails the scan.

## What this monitor will not do

- It will not contact a patient, close a cycle, flip a flag, submit a
  claim, or write a ship date. It is read-only outside its own two tables.
- It will not alert per patient. Every signal is a count, an age or a ratio
  over a population.
- It will not report a failed read as a healthy zero, and it will not
  resolve an open alert because a read failed.
- It will not claim a connector, a feed or an integration is validated. Only
  the evidence in
  [`../reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md)
  can do that.
