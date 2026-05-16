# `@workspace/resupply-auth`

In-house authentication primitives for PennFit / Resupply. Owned by
this app — no third-party identity vendor in the loop. See
`docs/resupply/adr/014-in-house-auth.md` and
`docs/resupply/AUTH-MIGRATION-PLAN.md`.

## Stage 1 (this lib's first cut)

What lands in Stage 1:

- The `auth` Postgres schema (`auth.users`, `auth.password_credentials`,
  `auth.sessions`, `auth.email_tokens`, `auth.login_attempts`) is
  created by the hand-written migration `0022_in_house_auth.sql`
  under `lib/resupply-db/drizzle/` (directory name is historical;
  see `lib/resupply-db/README.md`). Row shapes are now sourced from
  the generated Supabase `Database` types in
  `@workspace/resupply-db`; callers read and write via the
  service-role client.
- Pure helpers: password hashing (argon2id), opaque session
  token generation + hashing, session expiry math, email-token
  generation.
- `readAuthEnv()` — reads and validates the optional
  `AUTH_SESSION_TTL_DAYS` and `AUTH_EMAIL_TOKEN_TTL_HOURS`. Accepts
  and ignores legacy `AUTH_PROVIDER` and `AUTH_PASSWORD_PEPPER`
  env values for back-compat with deploys that still set them.

> **Task #38 follow-up:** the previous version of `password.ts`
> HMAC'd the password with a server-side `AUTH_PASSWORD_PEPPER`
> before feeding it into argon2id. The pepper was removed for
> operational reasons (deploys silently breaking when the secret
> was missing/invalid). Argon2id alone is the password-hashing
> primitive now. Stored hashes from before the removal will no
> longer validate; affected users have to use the password-reset
> flow once.

## Why a separate package

Auth logic that ends up scattered across two APIs is the kind of
thing that drifts. A single library with thoroughly tested
primitives means every consumer gets the same hashing parameters,
the same session-cookie format, and the same audit-log payloads.
