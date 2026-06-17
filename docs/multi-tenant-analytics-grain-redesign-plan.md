# Multi-Tenant: Analytics-Grain Redesign Plan (deferred G2 tail)

**Date:** 2026-06-17
**Status:** ✅ **DONE** (PR #1071) — all three slices shipped; this doc is
retained as the design record. Migrations `0380` (metrics trio) / `0381`
(therapy fleet + 4 RPCs) / `0382` (payer stats + fitter view) re-key every
grain-keyed aggregate per tenant, with the runtime cutover (per-tenant
fan-out writers, org-scoped RPCs, host-org storefront read, and the admin
dashboards/views filtered by org). `integration_run_health` needed no change
— already per-tenant by convention (rows keyed `${JOB}:${orgId}`). The
sections below are the original plan; where they say "to do", read "done in
PR #1071".
**Parent:**
[`multi-tenant-remaining-work-plan-2026-06-15.md`](./multi-tenant-remaining-work-plan-2026-06-15.md)

## Why this is a separate workstream

Every other tenant-scoped table got `org_id` as an **additive nullable
column + seed backfill** (migrations `0331`–`0351`). A small set of
**grain-keyed AGGREGATE / counter tables** was **deliberately excluded** —
see the header of
[`0342_org_id_stragglers.sql`](../lib/resupply-db/drizzle/0342_org_id_stragglers.sql):

> Grain-keyed AGGREGATE / counter tables (metrics_daily,
> therapy_fleet_daily_metrics, fitter_campaign_touch_metrics +
> \_variant_metrics, payer_estimate_stats, integration_run_health,
> control_number_counters). Their primary key is a non-tenant dimension
> (date / payer slug / touch_index / adapter key / pool), so per-tenant
> scoping is a **PK/grain REDESIGN + recompute, not an additive nullable
> column** — deferred to the Phase-1 analytics multitenancy workstream.

For these tables `org_id` must enter the **primary key / grain**, and the
**writers must recompute their aggregations per tenant** (a global
`COUNT(*)`/`SUM()` becomes a `GROUP BY org_id`). That is a behavioural
change to the analytics pipeline, not a column add — hence its own plan.

Until this lands, the pipeline runs **platform-wide** (single global
aggregate across all tenants) and its two operator emails are correctly
treated as **platform** alerts (their seed-brand leak was already fixed —
`owner-digest` and `failed-order-emails-digest` now use `PLATFORM_NAME`).

## Affected schema (the grain-keyed set)

| Table                             | Current grain (PK / unique)            | Target grain                                 |
| --------------------------------- | -------------------------------------- | -------------------------------------------- |
| `metrics_daily`                   | PK `(metric_date, metric_key)`         | PK `(org_id, metric_date, metric_key)`       |
| `metric_thresholds`               | PK `id`; enabled-idx on `(metric_key)` | add `org_id`; unique `(org_id, metric_key)`  |
| `metric_alerts`                   | PK `id`; unique `(threshold_id, date)` | add `org_id` (threshold already implies org) |
| `therapy_fleet_daily_metrics`     | day-grain aggregate                    | PK gains `org_id`                            |
| `fitter_campaign_touch_metrics`   | `(…, touch_index)` counter             | PK gains `org_id`                            |
| `fitter_campaign_variant_metrics` | variant counter                        | PK gains `org_id`                            |
| `payer_estimate_stats`            | `(payer_slug, …)` counter              | PK gains `org_id`                            |
| `integration_run_health`          | `(adapter_key)` counter                | PK gains `org_id`                            |

Source of truth for grains:
[`0194_metrics_substrate.sql`](../lib/resupply-db/drizzle/0194_metrics_substrate.sql)
(metrics trio) and the per-table create migrations for the rest.

> **`control_number_counters` is already DONE (not part of this work).** The
> X12 claim control-number pool was also grain-keyed and deferred by `0342`,
> but because it is a **billing-correctness** gap (two tenants drawing from
> one ISA13 sequence collide at Office Ally's 999) it was pulled forward and
> shipped on its own: migration
> [`0361_control_number_counters_org_scoped.sql`](../lib/resupply-db/drizzle/0361_control_number_counters_org_scoped.sql)
> re-keys the PK to `(org_id, pool)` + adds RLS, and the runtime cutover
> landed in the same PR (`reserveIsa13Value` takes the caller's org-scoped
> client and self-provisions a new tenant's counter row). It is listed here
> only so nobody re-does it; it is **not** in scope below.

## Affected jobs (the pipeline)

All currently resolve a single org via `resolveSeedOrgId()` and read/write
the global aggregate. Each must become a per-tenant fan-out
(`forEachActiveOrg`) **after** the grain redesign:

1. `worker/jobs/metrics-snapshot.ts` — **writer.** Collectors derive from
   `shop_orders` (`COUNT`/`SUM`); they must filter/`GROUP BY org_id` and
   upsert on `(org_id, metric_date, metric_key)`.
2. `worker/jobs/metric-alerts-evaluator.ts` — **reader + alert writer.**
   Reads enabled `metric_thresholds` and the latest `metrics_daily` via the
   `metrics_daily_latest(text[])` RPC; writes `metric_alerts`. Both the
   threshold read and the RPC must be org-scoped.
3. `worker/jobs/metric-alerts-notify.ts` — **reader.** Notifies on new
   `metric_alerts`; recipients + brand resolve per tenant.
4. `worker/jobs/owner-digest.ts` — **reader.** Today a platform digest to
   `RESUPPLY_ADMIN_EMAILS`. Post-redesign it becomes a **per-tenant** owner
   digest (each tenant owner gets their own KPIs), branded per tenant.
5. `worker/jobs/therapy-fleet-daily-snapshot.ts` — **writer** of
   `therapy_fleet_daily_metrics`.

## RPC changes

- `resupply.metrics_daily_latest(p_metric_keys text[])`
  (`0232_worker_batch_rpcs.sql`) does `DISTINCT ON (metric_key) … ORDER BY
metric_key, metric_date DESC`. Add a `p_org_id uuid` parameter and an
  `org_id =` predicate, and key the `DISTINCT ON` within the org. Any other
  metrics RPC that reads these tables gets the same treatment. Keep the old
  signature only if a global rollup is still wanted for the platform
  console (it is, for G12 billing — see below).

## Migration approach (the hard part)

This is **not** the additive `ADD COLUMN org_id … backfill seed` shape used
elsewhere — the column joins the **primary key**, so:

1. **Add `org_id`** nullable, FK to `organizations(id)`, backfill the
   existing rows to the seed org (`slug = 'penn-home-medical'`).
2. **Re-key** each table: drop the old PK/unique, add the new
   `(org_id, …)` PK/unique. For `metrics_daily` this is
   `PRIMARY KEY (org_id, metric_date, metric_key)`; for `metric_thresholds`
   a unique `(org_id, metric_key)` (the partial enabled-index becomes
   `(org_id, metric_key) WHERE enabled`).
3. **Set `org_id` NOT NULL** once backfilled.
4. The historical rows are now all attributed to the seed tenant — correct,
   since they were single-tenant. **No recompute of history is needed**;
   only go-forward snapshots are per-tenant.
5. Respect the migration guards: new prefix = current max + 1, hand-written
   SQL, never edit shipped migrations, do **not** touch
   `drizzle/meta/_journal.json` (frozen at 52).

## Interaction with G12 (per-org usage metering — already merged)

G12 already meters per-org usage into `tenant_usage_monthly_rollups` via an
atomic-increment RPC (`0367`) and the platform billing console reads it.
That path is **independent** of `metrics_daily` and is **not** part of this
redesign — do not conflate the two. The platform billing/KPI console may
still want a **global** rollup across tenants; keep a platform-level read
path (either the old RPC signature or a `SUM` over the now-org-keyed table)
for `/platform/*`.

## Test strategy

- The writers/readers need the **Node-24 worker integration suite** (the
  same gate the SUITE-GATED cron tail used) to exercise a real
  two-tenant fan-out: seed + a second org, assert each tenant's
  `metrics_daily` rows are computed from **its own** `shop_orders` and that
  one tenant's threshold breach never fires on another tenant's metric.
- Pure unit tests for the collectors (already exist for `buildMetricsRows`)
  extend to assert per-org grouping.
- A migration-replay test confirms the re-key + seed backfill is clean on a
  populated DB.

## Suggested sequencing

The billing slice (`control_number_counters`) that would have led here is
**already shipped** (migration `0361` — see the note above), so the
remaining work is purely analytics/dashboards and carries no
patient-serving or billing urgency:

1. **metrics trio** (`metrics_daily` + `metric_thresholds` +
   `metric_alerts`) + their three jobs + the RPC, as one coordinated unit.
2. **`therapy_fleet_daily_metrics`** + its snapshot job.
3. The remaining counters (`fitter_campaign_*`, `payer_estimate_stats`,
   `integration_run_health`) — lowest urgency; they back internal
   dashboards, not patient- or tenant-facing surfaces.

## Risk / blast radius

- Re-keying a populated PK is the riskiest DB step in the multi-tenant
  programme so far; gate the deploy on the migration (the `railway.json`
  `preDeployCommand` already does this) and keep the change reversible
  (the seed-backfilled column means a rollback to the global read still
  resolves the seed tenant's rows).
- The analytics pipeline is **not on the patient-serving path** — a bug
  here degrades operator dashboards/alerts, not storefront or billing — so
  it is lower-stakes than G1/G6/G7/G8 were, which is part of why it was
  safely deferred.
