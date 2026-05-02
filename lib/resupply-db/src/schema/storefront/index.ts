// Storefront tables (PennPaps fitter — orders, usage events, audit log,
// reminder subscriptions). These live in the default `public` Postgres
// schema and were previously owned by the now-deleted `@workspace/db`
// package. They were folded into `@workspace/resupply-db` as part of the
// "one DB, one API" consolidation (Task #37) so the codebase has a
// single source of truth for every table in the physical database.
//
// Despite the namespace move, the underlying SQL tables live exactly
// where they did before (`public.orders`, `public.usage_events`, etc.) —
// no `ALTER TABLE ... SET SCHEMA` was performed. That keeps existing
// data and FKs untouched and lets us deploy the merge as a no-op against
// any database that already has these tables (see migration 0027 for
// the `IF NOT EXISTS` guards).

export * from "./orders";
export * from "./usage-events";
export * from "./admin-audit-log";
export * from "./reminder-subscriptions";
