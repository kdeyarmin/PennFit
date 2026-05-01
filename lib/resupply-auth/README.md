# `@workspace/resupply-auth`

In-house authentication primitives for PennFit / Resupply. Owned by
this app — no third-party identity vendor in the loop. See
`docs/resupply/adr/014-in-house-auth.md` and
`docs/resupply/AUTH-MIGRATION-PLAN.md`.

## Stage 1 (this lib's first cut)

What lands in Stage 1:

- Drizzle schema definitions for the new `auth` Postgres schema
  (`auth.users`, `auth.password_credentials`, `auth.sessions`,
  `auth.email_tokens`, `auth.login_attempts`). Tables are created by
  the hand-written migration `0022_in_house_auth.sql` in
  `lib/resupply-db/drizzle/`.
- Pure helpers: password hashing (argon2id + pepper), opaque session
  token generation + hashing, session expiry math, email-token
  generation.
- `readAuthEnv()` — reads and validates `AUTH_PROVIDER`,
  `AUTH_PASSWORD_PEPPER`, `AUTH_SESSION_TTL_DAYS`,
  `AUTH_EMAIL_TOKEN_TTL_HOURS`. Defaults `AUTH_PROVIDER=clerk` so
  Stage 1 is a no-op at runtime.

What does NOT land in Stage 1: HTTP routes, middleware, or any
production code path that flips off Clerk. Those arrive in Stage 2 —
behind the `AUTH_PROVIDER=dual` flag — per the migration plan.

## Why a separate package

Auth logic that ends up scattered across two APIs is the kind of
thing that drifts. A single library with thoroughly tested
primitives means every consumer gets the same hashing parameters,
the same session-cookie format, and the same audit-log payloads.
