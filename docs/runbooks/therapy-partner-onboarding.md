# Runbook — turning on a therapy-cloud partner

How to take one of the three device-manufacturer integrations from
"written against published docs" to "trusted enough to make clinical
decisions from".

There are two halves and only one of them is code. The agreements and
credentials are yours to obtain; everything after that is in the app.

---

## What already exists in the app

All three adapters make **real** OAuth2 + HTTP calls. Nothing is mocked,
and an unconfigured adapter returns an error rather than fabricating a
snapshot (pinned by `airview/src/adapter.test.ts` — "returns an
unavailable error (no fabricated snapshot)").

| Vendor                    | Package                                       | Credentials           |
| ------------------------- | --------------------------------------------- | --------------------- |
| ResMed AirView            | `lib/resupply-integrations-airview`           | `AIRVIEW_*`           |
| Philips Care Orchestrator | `lib/resupply-integrations-care-orchestrator` | `CARE_ORCHESTRATOR_*` |
| 3B Medical / React Health | `lib/resupply-integrations-react-health`      | `REACT_HEALTH_*`      |

Credentials are **tenant-scoped** app-config keys, so each practice
configures its own from System Configuration. They are read at CALL time,
so a rotation takes effect without a restart.

> **The endpoint paths are written from published documentation and have
> never been exercised against a live instance.** That is the single
> biggest risk in this list, and it is why the validation step below
> exists. React Health in particular had a known divergence: the docs
> nest resources under the account and the client called a flat shape.
> The documented (nested) shape is now the default, with
> `REACT_HEALTH_RESOURCE_PATH_STYLE=flat` as an override if a partner
> instance turns out to serve the other one.

---

## Step 1 — the agreements (out of band)

Each vendor gates API access behind a signed agreement. None of this
happens in the app; it is here so the sequence is written down once.

| Vendor                     | What to ask for                                        | Typically needs                                                     |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| ResMed AirView             | AirView API / partner data access for your DME account | A signed data-sharing agreement and a BAA; a DME account identifier |
| Philips Care Orchestrator  | Care Orchestrator partner API access                   | Partner agreement and a BAA; a partner identifier                   |
| 3B Medical (iCode Connect) | iCode Connect partner API access                       | Partner agreement and a BAA; an account identifier                  |

Two things to settle **while you are talking to them**, because they are
expensive to discover afterwards:

1. **The exact resource paths and the OAuth scope** their instance
   serves. Ask for a sample response, not just the doc URL.
2. **Whether patient consent is handled on their side or yours.** This
   is device usage data for identified patients; who is responsible for
   the consent record is not a detail to assume.

When they issue credentials, set them per practice under System
Configuration. Nothing else needs a deploy.

---

## Step 2 — validate the connection (before trusting the nightly sync)

**Do not skip this.** Until you run it, the first real call to the vendor
will happen inside the nightly sync at 04:30, across every linked
patient — and there, a wrong endpoint shape is **indistinguishable from
"the vendor has no data for these patients"**: availability reports
configured, the fetch returns `not_found`, the job logs a count, and the
practice believes it is monitoring people it is not.

Pick a patient you can see in the vendor's own portal, then:

```
POST /resupply-api/admin/integrations/<source>/validate
{ "partnerPatientId": "<their id for that patient>" }
```

(`<source>` is `resmed_airview`, `philips_care`, or `react_health`.)

Nine named steps come back, and the first failure tells you exactly which
half of the problem you have. Each step reports **pass / fail / skipped /
no_data**, and the difference between the last two matters: a vendor that
answered and had nothing is not a broken endpoint.

| Step              | Failing means                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `configured`      | Credentials are not set for this practice.                                                                                                                                                             |
| `authenticated`   | **401.** The vendor rejected the credentials. Rotate or re-issue; the paths are not the problem.                                                                                                       |
| `authorized`      | **403.** The credentials are _fine_ and this account is not entitled to the resource. Almost always a missing partnership agreement or an un-provisioned scope. **Do not rotate the secret.**          |
| `patient_lookup`  | The patient endpoint failed. `endpoint_not_found` means the **path shape** is wrong for this instance; `no_data` on this step means the vendor has no such patient — check the id, not the connection. |
| `usage_data`      | Therapy nights came back broken. `no_data` here is normal for a new patient.                                                                                                                           |
| `compliance_data` | The compliance summary came back broken. Several vendors gate this separately from the patient record.                                                                                                 |
| `device_settings` | Device settings came back broken.                                                                                                                                                                      |
| `pagination`      | The night count landed on a suspiciously round number for the window — what a truncated page looks like. Confirm the vendor is not capping the response.                                               |
| `schema`          | The vendor answered with something we cannot map. The response has changed shape; the named fields say where.                                                                                          |

Every failed step carries a **remedy** sentence saying what to do about
it, drawn from the classified error category — so the report distinguishes
"rotate the secret", "call the vendor about the agreement", "the URL is
wrong", and "they changed their schema", which used to all read the same.

On success it also reports what came back — settings, compliance, night
count, supply count — so you can see a connection that is technically up
and returning nothing. A `partial` list names any sub-resource the vendor
refused while the patient record itself succeeded; a snapshot missing its
compliance summary because that ONE endpoint 403'd is not a patient with
no compliance data.

### The outcome is recorded

Every run writes `resupply.integration_connector_status` (migration
0542), which is what `/admin/integrations` reads. It keeps **attempted**
and **succeeded** timestamps separate, because "last tried at 04:30, last
succeeded three weeks ago" is the shape of a connector that has been
broken for three weeks and a single `last_run_at` cannot say it.

| Connector status | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `unvalidated`    | Credentials may be present; **nothing has proved they work**. The default, and the honest starting state. |
| `not_configured` | No credentials for this practice.                                                                         |
| `live_validated` | A real vendor call succeeded here. **The only value that supports a "Production Validated" claim.**       |
| `degraded`       | It worked before and is failing now, or returns partial data.                                             |
| `failing`        | Consecutive failures.                                                                                     |

The database refuses a `live_validated` row with no success timestamp, so
"we marked it validated but nothing ever succeeded" is not expressible.

A nightly sync that happens to succeed **cannot** promote a connector to
`live_validated` — that is reserved for the deliberate, attributed probe
an operator ran and kept evidence for. A sync can only refresh a
validated connector or demote one.

The response carries step outcomes and vendor error codes only. No
patient payload is stored: proving the pipe should not put real therapy
data into a diagnostic record.

---

## Step 3 — reconcile against the portal

Validation proves one patient works. Reconciliation is what tells you the
whole feed is right, and it is the only check in the system that is not a
check against ourselves — `diff-settings.ts` compares our new snapshot to
our own **previous** snapshot, which by construction cannot notice that
we are missing a patient, missing nights, or reading a device the portal
swapped out.

Export the vendor's own patient/compliance report from their portal for a
window (30 days is a reasonable first pass), then run it through
`/admin/integrations` → **Reconcile against portal**. The UI maps the
export's columns; the server diffs.

**Set the date range to the window your export actually covers.** Patient
presence and device serials are compared without it, but night counts and
average usage are not: our therapy nights are a rolling history and the
portal's export is a fixed period, and comparing the two over different
spans would flag every patient in the practice. With no range given, those
two comparisons are skipped and the result says so in as many words —
rather than reporting zero discrepancies it never looked for.

What it reports:

| Finding                | What it usually means                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Missing locally        | A patient the practice believes is monitored who has never been linked. **Start here.**                              |
| Missing in portal      | A link we hold the portal no longer lists — usually a departed patient, occasionally a link pointed at the wrong id. |
| Device serial mismatch | The machine changed and nobody told us. Affects which supplies are right for them.                                   |
| Night count mismatch   | We are behind. Compliance decisions and resupply eligibility are made from this number.                              |
| Usage mismatch         | Same, on the average.                                                                                                |

Night counts and usage are read from `patient_therapy_nights` — the same
rollup the compliance rules read — so this compares the portal against the
number the practice actually acts on, not a second copy of it. A night the
device never reported is a gap, not a zero, and counts toward neither the
tally nor the average.

Tolerances are deliberate: one night and fifteen minutes. The portal and
the sync run at different times in different timezones, so the most
recent night is routinely on one side and not the other — zero tolerance
would report every patient in the practice, which is
indistinguishable from reporting none.

Each run is recorded, so a practice can see whether the gap is **closing**
rather than only how big it is today. Re-run monthly, and after any
vendor-side change.

---

## Step 3b — automated live tests (optional, opt-in)

Once non-production credentials exist, the validator can be run as a test:

```bash
INTEGRATION_LIVE_TESTS=1 \
INTEGRATION_LIVE_SOURCE=resmed_airview \
INTEGRATION_LIVE_ORG_ID=<tenant uuid in a NON-PRODUCTION database> \
INTEGRATION_LIVE_PATIENT_ID=<the vendor's designated test patient> \
pnpm --filter @workspace/resupply-api exec vitest run \
  src/lib/integrations/live-connection.live.test.ts
```

It is **off by default** and **skips visibly** without those variables.
That is deliberate: a live test that quietly passes without credentials
is worse than no live test, because it makes a connector look validated
when nothing was contacted. Every call is a GET; the suite refuses to run
with `DEPLOY_ENV=production`.

---

## Step 4 — watch it stay working

- `/admin/integrations` shows per-adapter **availability** and **connector
  status** side by side, and the pair is the point. `availability()` reads
  environment variables — a revoked secret, a missing entitlement and a
  wrong endpoint path all pass it. Connector status is what happened when
  we actually called.
- Failures are **classified**, and the classification decides what
  happens next: a configuration failure (bad credential, missing
  entitlement, wrong path, schema drift) is **never retried**, because
  retrying a wrong client secret across a thousand links is how an
  account gets locked out by the vendor. Transient failures retry with
  full jitter, and a per-`(source, tenant)` circuit breaker opens after
  five consecutive unhealthy results so one broken credential cannot
  hammer a vendor for an entire run.
- A vendor that legitimately has no data for a patient **never** trips the
  breaker or marks the connector unhealthy.
- 7-day ok/error counts remain, per adapter.
- A snapshot now records `partial` when the vendor answered but left a
  sub-resource empty (no settings, or no nights in the window). Before
  this, a patient whose therapy feed had gone quiet was recorded
  identically to one syncing perfectly. A rising `partial` count is a
  connection that is up and returning nothing.
- The nightly sync alerts per tenant at an 80% failure rate.
- `GET /admin/integrations/errors` lists recent failures for triage.

---

## If a vendor changes their API

The `schema` step of the validator is the fast check — run it against one
patient and read the named fields. Every client funnels through a single
`request()` helper and a single mapping function per resource, so a shape
change is one file per vendor.

Do **not** loosen the snapshot schema to make an error go away. It is
what stops a half-mapped response being persisted as though it were
complete, and a partially-mapped therapy feed is worse than a missing
one: it looks like data.

---

## Evidence to retain per vendor

Nothing in this repository has been validated against a live vendor
instance. Record these in
[`../reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md);
a connector is not "Production Validated" until all five exist.

| #   | Evidence                                                                          | Where it comes from                                          |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | The signed agreement + BAA reference                                              | The vendor, out of band                                      |
| 2   | The vendor's sample response for each resource                                    | Ask during Step 1 — a doc URL is not a sample                |
| 3   | A validation run whose ladder is green to `schema`                                | `POST /admin/integrations/<source>/validate`; keep the JSON  |
| 4   | `integration_connector_status.status = 'live_validated'` with a success timestamp | `/admin/integrations`                                        |
| 5   | One reconciliation run against a portal export, with the discrepancies explained  | `/admin/integrations` → Reconcile; keep the sanitized report |

Until (3) and (4) exist for a vendor, the honest label is **fixture
validated only** — the adapters are exercised by contract tests against
sanitized fixtures, and nothing more.
