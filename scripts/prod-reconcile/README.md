# Prod schema reconciliation scripts

One-time, point-in-time artifacts for bringing the PennPaps production project
(`uppdjphagdildcgkvdsz`) up to the canonical migration schema. **These are NOT
repo migrations** — they live here, not in `lib/resupply-db/drizzle/`, because
they `CREATE TABLE` objects that the normal migration chain already creates
(running them as part of a from-scratch replay would collide). See
[`docs/prod-schema-reconcile-2026-05-31.md`](../../docs/prod-schema-reconcile-2026-05-31.md).

## `2026-05-31-provision-missing-56-tables.sql`

Byte-exact canonical DDL + seed data for the **56 feature tables that were
absent on prod** as of 2026-05-31 (prod had 80 of the canonical 136 `resupply`
tables). Generated deterministically:

1. Replay the full `0000..0185` chain into a scratch Postgres:
   `DATABASE_URL=postgres://… node lib/resupply-db/scripts/migrate.mjs`
   (create roles `anon`/`authenticated`/`service_role` first).
2. `pg_dump --no-owner --no-comments --quote-all-identifiers --column-inserts
   -t resupply.<each-missing-table> …` (table list:
   `2026-05-31-missing-tables.txt`), with the leading `\restrict`/`\unrestrict`
   psql guards stripped.

It contains 56 `CREATE TABLE`, their indexes / PK+FK constraints / `ENABLE ROW
LEVEL SECURITY` (no policies — same posture as the existing tables; the
service-role data path bypasses RLS), one trigger, and 98 seed `INSERT`s
(`hcpcs_codes`, `alert_definitions`/`alert_messages`, `payer_modifier_rules`,
`sku_hcpcs_map`/`product_hcpcs_map`, `claim_templates`). It carries **no
`GRANT`s** — prod has `ALTER DEFAULT PRIVILEGES … GRANT … TO service_role`, so
tables created by the admin role auto-grant the service-role data path.

Sections are in pg_dump order (pre-data → data → post-data), so applying the
whole file in one transaction loads seed rows before FK constraints are added.

### Apply (requires prod DB access — not available in the web session that
### prepared this)

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/prod-reconcile/2026-05-31-provision-missing-56-tables.sql
```

`CREATE TABLE` here is **not** `IF NOT EXISTS` — it is intended to run exactly
once against a prod DB that is missing these tables; it errors (and the
transaction rolls back, leaving prod untouched) if a table already exists.
After applying, re-run `pnpm --filter @workspace/scripts check:schema-drift`
against prod and confirm `resupply` is at 136 tables.

> The column-level drift (65 columns) and the 11 missing RPC functions were
> already applied to prod out-of-band on 2026-05-31 and are verified; only
> these 56 tables remained.
