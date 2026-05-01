# `@workspace/resupply-auth`

In-house authentication primitives for PennPaps / Resupply. Owned by
this app — no third-party identity vendor in the loop. See
`docs/resupply/adr/014-in-house-auth.md` and
`docs/resupply/AUTH-MIGRATION-PLAN.md` for the design history.

## What lives here

- Drizzle schema definitions for the `auth` Postgres schema
  (`auth.users`, `auth.password_credentials`, `auth.sessions`,
  `auth.email_tokens`, `auth.login_attempts`). Tables are created by
  the hand-written migration `0022_in_house_auth.sql` in
  `lib/resupply-db/drizzle/`.
- Pure helpers: password hashing (argon2id + pepper), opaque session
  token generation + hashing, session expiry math, email-token
  generation.
- HTTP routes + Express middleware that the api-server and
  resupply-api mount at `/api/auth/*` and `/auth/*` respectively.
- `readAuthEnv()` — reads and validates `AUTH_PASSWORD_PEPPER`,
  `AUTH_SESSION_TTL_DAYS` (default 14), and
  `AUTH_EMAIL_TOKEN_TTL_HOURS` (default 24). Throws if the pepper is
  missing or shorter than 32 bytes. Accepts and ignores legacy
  `AUTH_PROVIDER` env values for back-compat with deploys that still
  set them.

## Why a separate package

Auth logic that ends up scattered across two APIs is the kind of
thing that drifts. A single library with thoroughly tested
primitives means every consumer gets the same hashing parameters,
the same session-cookie format, and the same audit-log payloads.
