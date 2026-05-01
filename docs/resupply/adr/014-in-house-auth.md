# ADR 014 — In-house authentication (supersedes ADR 005)

## Context

ADR 005 chose a third-party identity vendor for admin and customer
authentication. The product direction has changed: we want sign-in
for both staff and customers managed entirely inside this monorepo,
with no third-party identity provider in the loop.

The HIPAA BAA constraint that originally pushed us toward a vendor
with healthcare paperwork is no longer a requirement for this
decision. Compliance posture for PHI in the database (encryption at
rest, audit logging, retention) is unchanged and continues to live
in `docs/resupply/PHI-RETENTION.md` and ADR 007. Auth is now treated
as a distinct concern owned by the application.

## Decision

Build and own the authentication stack inside the monorepo:

- A new `lib/resupply-auth` package owns user, session, password,
  email-verification, and rate-limiting primitives.
- Identity is stored in a Postgres `auth` schema (Drizzle migrations
  in `lib/resupply-db`).
- Passwords are hashed with argon2id and a server-side pepper.
- Sessions are opaque server-issued tokens stored hashed in Postgres,
  delivered to browsers as `httpOnly; Secure; SameSite=Lax` cookies.
- Roles (`customer`, `agent`, `admin`) live on `auth.users`. The
  existing `RESUPPLY_ADMIN_EMAILS` / `PENN_ADMIN_EMAILS` /
  `*_AGENT_EMAILS` env vars remain only as a bootstrap allow-list for
  the very first login of a new admin; thereafter the DB role is
  authoritative.
- Both `requireSession` and `requireRole` middlewares are the only
  auth surface in `artifacts/api-server` and `artifacts/resupply-api`.
- The sign-in / sign-up surfaces in cpap-fitter and resupply-dashboard
  are first-party React pages that call our own endpoints.

## Consequences

- No third-party identity vendor. No vendor BAA, no vendor outage,
  no vendor cost line.
- We now own the security boundary: password hashing, rate limiting,
  session revocation, account enumeration defenses, audit logging,
  password reset flows, and email verification all sit in our code.
- One-time engineering cost across schema, two APIs, and two SPAs.
- Auth-related operational pages (sign-in, password reset, verify
  email) are now part of our deploy surface and on-call rotation.

## Alternatives Considered

- **Stay on a hosted IdP (Auth0, WorkOS, Cognito, Supabase Auth, or
  the previous vendor)** — works today but leaves identity, MFA
  policy, and the sign-in UX outside our control, and ties the user
  list to a vendor account. Doesn't satisfy the "managed entirely
  in this app" requirement.
- **Lucia / Better-Auth / Auth.js libraries** — viable; deferred to
  keep the surface area small and avoid an opinionated framework
  dependency. Revisit if the in-house code grows beyond the scope
  in `lib/resupply-auth`.

## Status

Accepted. Supersedes ADR 005.
