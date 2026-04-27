# @workspace/resupply-worker

The resupply background worker. Hosts pg-boss against the shared Postgres
instance and runs all multi-day outreach workflows. See `docs/resupply/adr/002-pgboss-not-temporal.md`
for why pg-boss instead of Temporal.

Phase 0 ships only the boot wiring — the worker connects to pg-boss, logs
`resupply-worker ready`, and stays alive. Real job handlers land in
Phase 2+.

## Run

```
pnpm --filter @workspace/resupply-worker run dev
```

Requires `DATABASE_URL` to be set (Replit provides this automatically when
a Postgres database is provisioned for the project).
