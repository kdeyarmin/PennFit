# Schema-drift detector — `drift_ro` role & `SCHEMA_DRIFT_DATABASE_URL`

Operational runbook for the live-DB schema-drift check: the read-only
database role that powers it, the GitHub secret that carries its
connection string, and how to rotate or revoke it.

This is the durable detector born out of the 2026-05-30 sign-in outage
([`docs/incident-signin-500-schema-drift-2026-05-30.md`](../incident-signin-500-schema-drift-2026-05-30.md)),
where `resupply_auth.password_credentials.set_by_admin_at` (migration
`0142`) had never been applied to production and every real sign-in
500'd with no automated signal. The detector exists so the _next_
missing column shows up as a daily alarm instead of an outage.

---

## How it's wired

```
.github/workflows/schema-drift.yml          (daily 13:00 UTC + workflow_dispatch)
  └─ env DATABASE_URL = secrets.SCHEMA_DRIFT_DATABASE_URL
       └─ pnpm --filter @workspace/scripts check:schema-drift
            └─ scripts/src/check-schema-drift.ts
                 └─ getDbPool()  (lib/resupply-db/src/pool.ts) → pg → live DB
```

- **Workflow:** [`.github/workflows/schema-drift.yml`](../../.github/workflows/schema-drift.yml).
  Runs on a daily cron and on manual `workflow_dispatch`. It is **not** a
  PR gate — per-PR CI has no live DB on purpose (see the workflow header).
  If `SCHEMA_DRIFT_DATABASE_URL` is unset the job **no-ops** with a notice
  instead of failing red.
- **Tool:** [`scripts/src/check-schema-drift.ts`](../../scripts/src/check-schema-drift.ts).
  Read-only. Parses every `lib/resupply-db/drizzle/*.sql` for additive DDL
  targeting `resupply` / `resupply_auth`, then asks the live DB (two
  `information_schema` SELECTs + one `to_regclass` for the
  `drizzle.resupply_migrations` ledger) which expected tables/columns are
  absent. Exit codes: `0` no drift · `1` drift found · `2` usage/env error
  · `3` internal error.
- **Secret:** repository secret `SCHEMA_DRIFT_DATABASE_URL` on
  `kdeyarmin/pennfit`, mapped straight to `DATABASE_URL` for the tool.

## Why this role can read PHI (read this before sizing the password)

`information_schema.tables` and `information_schema.columns` are
**privilege-filtered**: PostgreSQL only returns rows for relations the
connecting role holds _some_ privilege on. A role with no grants sees
**zero** tables, so the detector would report the entire schema as
"missing" — a false alarm every morning that trains the on-call to
ignore the signal (defeating the whole point).

To list every table/column correctly, `drift_ro` must therefore hold
`SELECT` on **every** table in `resupply` and `resupply_auth` — and
`SELECT` _is_ read access to the row data. So despite being "read-only,"
this credential **can read all patient and auth/credential rows**. Treat
the connection string as a PHI-bearing secret: a strong password and
tight secret hygiene, not "it's just a structural check."

> If you ever want a credential that genuinely cannot read row data, the
> tool would have to be switched from `information_schema` to
> `pg_catalog` (`pg_class` / `pg_attribute`, world-readable, no grants
> needed). That is a code change, not a grants change — out of scope for
> this runbook, noted as the cleaner long-term design.

## The `drift_ro` role (production: PennPaps)

| Fact             | Value                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase project | PennPaps — ref `uppdjphagdildcgkvdsz`, region `us-west-2`                                                                                                   |
| Role             | `drift_ro` (`LOGIN`, no other attributes)                                                                                                                   |
| Privileges       | `USAGE` on `resupply` + `resupply_auth`; `SELECT` on all tables in both; default privileges `FOR ROLE postgres` so future migration tables are auto-covered |
| Verified         | 80 `resupply` + 5 `resupply_auth` base tables, all selectable                                                                                               |

Provisioning SQL (idempotent — safe to re-run; sets/updates the password):

```sql
-- 1. Create or re-password the role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drift_ro') THEN
    CREATE ROLE drift_ro LOGIN PASSWORD '<password>';
  ELSE
    ALTER ROLE drift_ro WITH LOGIN PASSWORD '<password>';
  END IF;
END
$$;

-- 2. Read grants on the two schemas the detector inspects.
GRANT USAGE  ON SCHEMA            resupply, resupply_auth TO drift_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA resupply, resupply_auth TO drift_ro;

-- 3. Cover FUTURE tables (default privs are keyed by the creating role;
--    migrations apply as postgres) so a new migration's table doesn't
--    trip a false "missing table" alarm before someone re-grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA resupply
  GRANT SELECT ON TABLES TO drift_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA resupply_auth
  GRANT SELECT ON TABLES TO drift_ro;
```

Re-verify the grants at any time (every base table must be selectable;
`selectable_by_drift_ro` must equal `total_tables` for both schemas):

```sql
SELECT
  t.table_schema,
  count(*) AS total_tables,
  count(*) FILTER (
    WHERE has_table_privilege('drift_ro',
      format('%I.%I', t.table_schema, t.table_name), 'SELECT')
  ) AS selectable_by_drift_ro
FROM information_schema.tables t
WHERE t.table_schema IN ('resupply', 'resupply_auth')
  AND t.table_type = 'BASE TABLE'
GROUP BY t.table_schema
ORDER BY t.table_schema;
```

If a future schema beyond these two is added to `SCHEMAS` in
`check-schema-drift.ts`, extend the `GRANT`/`ALTER DEFAULT PRIVILEGES`
above to that schema too, or the detector will report all of its tables
as missing.

## The connection string (the secret's value)

The value of `SCHEMA_DRIFT_DATABASE_URL` is a normal Postgres URL through
the Supabase **session pooler**:

```
postgresql://drift_ro.uppdjphagdildcgkvdsz:<password>@<pooler-host>:5432/postgres?sslmode=no-verify
```

Component notes:

- **Username `drift_ro.uppdjphagdildcgkvdsz`** — Supavisor (the pooler)
  embeds the project ref in the username (`<role>.<ref>`).
- **Pooler host** — `aws-0-us-west-2.pooler.supabase.com` **or**
  `aws-1-us-west-2.pooler.supabase.com`. Both resolve; copy the exact one
  from the dashboard → project **PennPaps** → **Connect** → **Session
  pooler** so you don't guess the cluster prefix.
- **Port `5432` (session pooler), not `6543` (transaction pooler).**
  `pg` uses session-level features the transaction pooler doesn't support.
- **`sslmode=no-verify` is deliberate — keep it.** `getDbPool()`
  (`lib/resupply-db/src/pool.ts`) passes **no** `ssl` config object, so
  the URL query string is the only place SSL is configured. `no-verify`
  reliably enables TLS with `rejectUnauthorized:false` across every
  `pg-connection-string` version; plain `sslmode=require` is a coin flip
  (older versions don't enable SSL at all; newer ones enable it _with_ CA
  verification, which fails on the pooler's cert chain). The connection
  stays encrypted in transit either way.
- A `!` (or other RFC-3986 sub-delimiter) in the password is URL-safe
  unencoded; `@ : / ? # %` would need percent-encoding.

Direct (non-pooler) connections to `db.uppdjphagdildcgkvdsz.supabase.co`
are **IPv6-only** and won't work from GitHub-hosted runners (IPv4) — use
the pooler.

## Set / update the GitHub secret

GitHub → **kdeyarmin/pennfit** → Settings → Secrets and variables →
Actions → secret **`SCHEMA_DRIFT_DATABASE_URL`** → paste the URL above.
No code change and no redeploy needed; the next workflow run picks it up.

## Validate

Actions → **"Schema drift (live DB)"** → **Run workflow**. A real run
(not the no-op) proves the credential connects.

**Expect a drift _finding_ on the first run, not a clean pass.** Per the
incident doc, production has **no `drizzle.resupply_migrations` ledger**,
which the tool reports as drift by design (exit `1`). That is the tool
working, not a regression — it stops being red once a ledger/runner is
restored (incident follow-up #1).

## Rotate the password

The password is weak by an explicit owner decision recorded in chat;
rotating to a strong random value is the recommended hardening and costs
one statement plus a secret update — **no overlap window to manage**
(only the daily CI job uses this role, and it reads the secret fresh on
each run):

```sql
ALTER ROLE drift_ro WITH PASSWORD '<new-strong-password>';
```

Then update the `SCHEMA_DRIFT_DATABASE_URL` secret with the new password.
Trigger the workflow once to confirm it still connects. Generate a value
with `openssl rand -base64 36` (then URL-encode any `@ : / ? # %`).

Rotate on: suspected secret leak, personnel change, or routine annual
hygiene.

## Revoke / decommission

If the detector is retired, drop the role to remove the standing PHI-read
grant:

```sql
DROP OWNED BY drift_ro;   -- removes the grants/default-priv entries
DROP ROLE drift_ro;
```

Then delete the `SCHEMA_DRIFT_DATABASE_URL` secret. (The workflow
self-no-ops once the secret is gone, so order doesn't matter.)

## Failure modes

- **Workflow run is the no-op message, not a real check** — the secret is
  unset or empty. Set it (above).
- **`Connection terminated due to connection timeout`** — wrong pooler
  host (confirm `aws-0` vs `aws-1` from the Connect panel), the runner
  can't egress to `:5432`, or the pool's 2 s `connectionTimeoutMillis`
  (`pool.ts`) was exceeded on a cold connect. Re-run; if persistent,
  re-copy the host.
- **TLS / self-signed cert error** — the URL lost `?sslmode=no-verify`
  (or it was changed to `require`). Restore `no-verify`.
- **Auth failures (`password authentication failed`)** — password in the
  secret drifted from the role; re-`ALTER ROLE … PASSWORD` and re-store
  the matching secret, or the username dropped its `.<ref>` suffix.
- **Detector reports tables/columns missing that you know exist** — the
  role lacks `SELECT` on them (e.g. a new schema or tables created by a
  role other than `postgres`, which the `FOR ROLE postgres` default
  privileges don't cover). Re-run the `GRANT SELECT ON ALL TABLES` and
  the re-verify query above.

## Related

- [`.github/workflows/schema-drift.yml`](../../.github/workflows/schema-drift.yml) — the scheduled job.
- [`scripts/src/check-schema-drift.ts`](../../scripts/src/check-schema-drift.ts) — the detector.
- [`lib/resupply-db/src/pool.ts`](../../lib/resupply-db/src/pool.ts) — `getDbPool()` (why `sslmode` lives in the URL).
- [`docs/incident-signin-500-schema-drift-2026-05-30.md`](../incident-signin-500-schema-drift-2026-05-30.md) — the outage that motivated the detector.
- [`docs/bucket-b-remediation-plan-2026-05-30.md`](../bucket-b-remediation-plan-2026-05-30.md) — the table-level remediation referenced by the incident.
