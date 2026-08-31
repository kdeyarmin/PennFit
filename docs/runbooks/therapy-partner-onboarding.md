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

Four named steps come back, and the first failure tells you which half of
the problem you have:

| Step            | Failing means                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configured`    | Credentials are not set for this practice.                                                                                                              |
| `authenticated` | The vendor rejected the credentials. Rotate or re-issue; the paths are not the problem.                                                                 |
| `fetched`       | Credentials are fine and the request failed. `not_found` usually means the **path shape** is wrong for this instance — not that the patient is missing. |
| `schema`        | The vendor answered with something we cannot map. The response has changed shape; the named fields say where.                                           |

On success it also reports what came back — settings, compliance, night
count, supply count — so you can see a connection that is technically up
and returning nothing.

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

What it reports:

| Finding                | What it usually means                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Missing locally        | A patient the practice believes is monitored who has never been linked. **Start here.**                              |
| Missing in portal      | A link we hold the portal no longer lists — usually a departed patient, occasionally a link pointed at the wrong id. |
| Device serial mismatch | The machine changed and nobody told us. Affects which supplies are right for them.                                   |
| Night count mismatch   | We are behind. Compliance decisions and resupply eligibility are made from this number.                              |
| Usage mismatch         | Same, on the average.                                                                                                |

Tolerances are deliberate: one night and fifteen minutes. The portal and
the sync run at different times in different timezones, so the most
recent night is routinely on one side and not the other — zero tolerance
would report every patient in the practice, which is
indistinguishable from reporting none.

Each run is recorded, so a practice can see whether the gap is **closing**
rather than only how big it is today. Re-run monthly, and after any
vendor-side change.

---

## Step 4 — watch it stay working

- `/admin/integrations` shows per-adapter availability and 7-day ok/error
  counts.
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
