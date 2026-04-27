# ADR 003 — Drizzle (not Prisma) for the resupply database

## Context

The original plan called for Prisma. The existing `lib/db` package already
uses Drizzle with `node-postgres`, and Penn Fit's Drizzle schema is the
template every new contributor in this repo learns first.

Two ORMs in one repo would mean two migration tools, two query languages,
two sets of generated types, and two answers to "where do I add a column?"

## Decision

Use Drizzle for the resupply schema in `lib/resupply-db`.

- Schema: one TypeScript file per logical area (`patients.ts`,
  `equipment.ts`, `consent.ts`, `suppression.ts`, `outreach.ts`,
  `conversations.ts`, `audit.ts`).
- Migrations: `drizzle-kit push` for prototyping; switch to generated SQL
  migrations (`drizzle-kit generate`) once we have real production data.
- Encryption for PHI fields: implemented as a Drizzle column transform that
  wraps pgcrypto's `pgp_sym_encrypt` / `pgp_sym_decrypt`. See ADR 007.
- Query patterns: relational queries via Drizzle's `with` builder; raw SQL
  for the rare reporting query.

The resupply tables live in their own Postgres schema (`resupply.*`) so they
do not collide with Penn Fit's tables (`public.orders`, `public.patients`
would conflict otherwise).

## Consequences

- Single ORM in the repo — easier onboarding, no double-maintenance.
- We give up Prisma Studio (a Prisma-specific GUI). Drizzle Studio exists
  and is sufficient.
- We give up Prisma's automatic migration generation from schema diffs;
  Drizzle's generator is a little less polished. For Phase 0 with empty
  tables this does not matter.

## Alternatives Considered

- **Prisma** — rejected as above.
- **Raw SQL + node-postgres** — rejected. Schemas are large; type-level
  guarantees are worth the ORM tax.
- **Kysely** — fine query builder, but Drizzle's schema-driven approach
  matches the rest of the repo.
