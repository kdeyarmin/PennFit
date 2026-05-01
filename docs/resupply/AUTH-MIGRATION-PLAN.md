# Auth migration plan — Clerk → in-house

This is the rollout plan referenced by [ADR 014](./adr/014-in-house-auth.md).
It supersedes the Clerk integration described in ADR 005.

## Goal

Sign-in for both staff and customers is owned by this app. No third-party
identity vendor in the loop. Migration happens in stages behind a feature
flag so neither product has a flag-day cutover.

## Scope

In scope:

- Customer sign-in/sign-up on the cash-pay shop (`cpap-fitter`).
- Staff sign-in on the resupply dashboard (`resupply-dashboard`) and the
  cpap-fitter admin (which today reads Clerk via the same `api-server`
  middleware).
- Replacing `requireAdmin` / `getAuth(req)` in both `artifacts/api-server`
  and `artifacts/resupply-api`.
- Password reset, email verification, session revocation.
- Decommissioning all `@clerk/*` packages and the `/api/__clerk` proxy.

Out of scope (defer):

- Patient passwordless magic-link portal (was Phase 10 in ADR 005).
  When it's revived, it will be implemented inside `lib/resupply-auth`
  using SendGrid + a short-lived verification token.
- MFA. Designed-for but not shipped in this migration.
- SSO / SAML for staff. Not needed; revisit if a partner asks.

## Architecture

### Identity model — new `auth` schema in Postgres

Migration owned by `lib/resupply-db` (Drizzle).

```
auth.users
  id              uuid pk
  email_lower     citext unique
  email_verified_at timestamptz null
  status          text  -- active | invited | locked | revoked
  role            text  -- customer | agent | admin
  display_name    text null
  created_at      timestamptz
  updated_at      timestamptz

auth.password_credentials
  user_id         uuid pk fk auth.users
  password_hash   text  -- argon2id encoded string
  algo            text  -- argon2id-v1
  must_change     boolean default false
  updated_at      timestamptz

auth.sessions
  id              uuid pk           -- random; never sent to client
  token_hash      bytea unique      -- sha-256 of opaque session token
  user_id         uuid fk
  issued_at       timestamptz
  expires_at      timestamptz
  last_seen_at    timestamptz
  revoked_at      timestamptz null
  ip              inet null
  user_agent_hash bytea null

auth.email_tokens
  token_hash      bytea pk          -- sha-256 of token
  user_id         uuid fk
  purpose         text              -- signup_verify | password_reset | email_change
  expires_at      timestamptz
  consumed_at     timestamptz null

auth.login_attempts
  id              bigserial pk
  email_lower     citext
  ip              inet
  success         boolean
  attempted_at    timestamptz
```

Indexes: `auth.sessions(user_id, revoked_at)`, `auth.login_attempts(email_lower, attempted_at)`, `auth.login_attempts(ip, attempted_at)`.

### Linking to existing tables

- `lib/resupply-db/src/schema/admin-users.ts` already has
  `clerk_user_id` and `clerk_invitation_id`. Add a nullable
  `auth_user_id uuid references auth.users(id)`. During cutover the
  invite flow will populate `auth_user_id`. After Stage 5, drop the
  Clerk columns.
- The shop customer table (whatever is referenced from
  `cpap-fitter` for Stripe customer linkage) gets the same nullable
  `auth_user_id` column with a backfill plan in Stage 4.

### Password hashing

- `argon2` npm package, argon2id, parameters tuned to ≈ 250 ms on
  prod hardware (`memoryCost: 19456, timeCost: 2, parallelism: 1`
  as a starting point — final values pinned in `lib/resupply-auth`).
- Server-side pepper from `AUTH_PASSWORD_PEPPER` (32+ bytes,
  base64). Password is HMAC-SHA256 with pepper before being passed
  to argon2.
- Re-hash on login if stored params drift from current target.

### Sessions

- Opaque token: 32 random bytes, base64url-encoded, never stored
  raw. Only `sha256(token)` is persisted.
- Cookie: `pf_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`,
  14-day sliding expiry refreshed on use.
- CSRF: SameSite=Lax covers GET-triggered cross-site; for state-
  changing fetches we additionally require an `X-PF-CSRF` header
  whose value matches a non-HttpOnly `pf_csrf` cookie issued at
  sign-in. (The custom-fetch wrapper in
  `lib/api-client-react/src/custom-fetch.ts` is the single place
  to wire this in; today it injects a Clerk JWT.)
- Sign-out invalidates by setting `revoked_at`. "Sign out
  everywhere" revokes all sessions for the user; runs automatically
  on password change.

### Roles

- `auth.users.role` is authoritative.
- `RESUPPLY_ADMIN_EMAILS` / `RESUPPLY_AGENT_EMAILS` /
  `PENN_ADMIN_EMAILS` / `PENN_AGENT_EMAILS` env vars become a
  *bootstrap* allow-list only: when an unknown email matching the
  allow-list signs up or signs in for the first time, we promote
  the new `auth.users` row to the matching role and write an
  `admin_users` row. After bootstrap, the env list has no effect on
  an existing user. (Current behaviour — env list checked on
  every request — goes away.)
- `RESUPPLY_OPERATOR_EMAILS` (already documented as deprecated)
  is dropped at Stage 5.

### Endpoints — new `lib/resupply-auth` HTTP module

Mounted under `/auth/*` on both APIs (or once on a shared mount
serving both). All endpoints rate-limited; all return generic
errors that don't disclose account existence.

| Method | Path                     | Notes                                              |
| ------ | ------------------------ | -------------------------------------------------- |
| POST   | `/auth/sign-up`          | email + password; sends verification email        |
| POST   | `/auth/sign-in`          | email + password; sets `pf_session` cookie        |
| POST   | `/auth/sign-out`         | revokes current session                            |
| POST   | `/auth/sign-out-all`     | revokes all sessions for current user              |
| POST   | `/auth/verify-email`     | consumes `signup_verify` token                     |
| POST   | `/auth/forgot-password`  | issues `password_reset` token over email           |
| POST   | `/auth/reset-password`   | consumes reset token, sets new password            |
| POST   | `/auth/change-password`  | authed; old + new password                         |
| GET    | `/auth/me`               | returns `{ id, email, role, emailVerified }` or 401 |

### Middleware

- `requireSession(req)` — reads `pf_session`, validates not
  revoked / not expired, attaches `req.auth = { userId, role }`.
  Replaces `clerkMiddleware()` + `getAuth(req)`.
- `requireRole(role)` — composes on top; replaces both
  `requireAdmin.ts` files. The dev-mode "any signed-in user is
  admin" fallback is removed; instead we provide a documented
  `pnpm auth:bootstrap-admin` script.

### Frontend

New pages on each app:

```
/sign-in            -> SignInPage          (email + password)
/sign-up            -> SignUpPage          (cpap-fitter only; staff are invited)
/verify-email       -> VerifyEmailPage     (consumes ?token=)
/forgot-password    -> ForgotPasswordPage
/reset-password     -> ResetPasswordPage   (consumes ?token=)
/account/security   -> ChangePasswordPage  (authed)
```

A new `useSession()` React Query hook hitting `GET /auth/me`
replaces every `useUser()` / `useAuth()` call site listed in the
audit. `ClerkProvider` and the Clerk JWT injection in
`artifacts/cpap-fitter/src/App.tsx` and
`artifacts/resupply-dashboard/src/main.tsx` are deleted.

## Feature flag

`AUTH_PROVIDER` env var, read by both APIs and exposed to the
SPAs as `VITE_AUTH_PROVIDER`:

- `clerk` — current behaviour (default until Stage 3).
- `dual`  — accept either a valid Clerk JWT or a valid local
  `pf_session` cookie. Used during cutover so a user mid-session
  is never logged out by a deploy.
- `in_house` — only local sessions accepted; Clerk middleware not
  mounted; Clerk SDK not loaded by the frontend.

## Stages

### Stage 0 — Decision (this PR)

- ADR 005 marked superseded.
- ADR 014 added.
- This migration plan landed in `docs/resupply/`.
- No code change.

### Stage 1 — Library + schema

- New `lib/resupply-auth` package skeleton (no routes wired yet).
- Drizzle migration creating the `auth` schema and the new
  `auth_user_id` columns on `admin_users` and on the shop customer
  table.
- `argon2` and `cookie` deps added to `lib/resupply-auth`.
- Unit tests for password hashing, token generation, session
  expiry math.
- `AUTH_PROVIDER` flag introduced; defaults to `clerk`. No
  user-visible change.

### Stage 2 — Endpoints + middleware

- `/auth/*` routes implemented in `lib/resupply-auth` and mounted
  on both `artifacts/api-server` and `artifacts/resupply-api`.
- `requireSession` + `requireRole` shipped alongside (not
  replacing) the existing Clerk middleware.
- When `AUTH_PROVIDER=dual`, `requireRole` accepts either a
  valid local session or a valid Clerk JWT (existing path).
- Rate limiting: in-process token bucket per IP and per email.
  Backed by a Postgres table so it survives restarts but doesn't
  require Redis.
- Audit log entries for sign-in, sign-in failure, password change,
  password reset, role change.
- Integration tests cover happy-path and abuse-path on every
  endpoint.

### Stage 3 — Staff cutover

- Staff sign-in / forgot / reset / verify pages built in both
  `cpap-fitter` (admin entry) and `resupply-dashboard`.
- "Set your password" email sent to every active row in
  `admin_users`, populating `auth_user_id` on first use.
- Flip `AUTH_PROVIDER=dual` in staging, then prod. Monitor.
- Once telemetry shows no traffic on the Clerk path for staff
  routes for 7 days, flip `AUTH_PROVIDER=in_house` for staff.
- Remove `ClerkProvider` from `resupply-dashboard`.
- The `cpap-fitter` ClerkProvider stays (still used by
  customers) until Stage 4.

### Stage 4 — Customer cutover

- Customer sign-in / sign-up / verify / forgot / reset pages built
  in `cpap-fitter`.
- Backfill `auth.users` for every Clerk shop customer (script
  reads Clerk's user export, creates rows with
  `status='invited'`, no password hash).
- On first visit after cutover, an invited customer is forced
  through `/forgot-password` (the email is pre-filled) to set a
  password. Existing Stripe customer linkage is preserved via the
  `auth_user_id` column added in Stage 1.
- Flip the shop to `AUTH_PROVIDER=in_house`.
- Remove `ClerkProvider` from `cpap-fitter`.

### Stage 5 — Decommission

- Delete `clerkMiddleware`, `requireAdmin`, `clerkProxyMiddleware`,
  and the `/api/__clerk` route.
- Drop `@clerk/express` and `@clerk/react` from all
  `package.json` files.
- Remove `CLERK_SECRET_KEY` and `VITE_CLERK_PUBLISHABLE_KEY` from
  `.env.example` and prod secrets.
- Drop `clerk_user_id` / `clerk_invitation_id` columns and the
  Clerk-specific fields on `admin_users`.
- Cancel the Clerk subscription.
- Remove the `AUTH_PROVIDER` flag (always in-house) once the
  rollback window has passed.

## Security controls shipped with cutover

Since there's no vendor security team behind this anymore, these
are non-negotiable for Stage 2:

- argon2id with peppered passwords.
- Generic "invalid email or password" response on sign-in.
- Same response shape and timing for `/auth/forgot-password`
  whether or not the email exists.
- Rate limiting: 5 failed attempts per email per 15 min, 30 per
  IP per hour, then exponential backoff.
- Email verification required before sign-in for new accounts.
- Session revoked on password change. All sessions revoked on
  password reset.
- Password policy: ≥ 12 characters, no upper bound, no composition
  rules. Optional opt-in check against
  `https://api.pwnedpasswords.com` k-anonymity API. (If we want to
  keep "no outside company in the loop" strictly, we leave this
  off and document the trade-off.)
- HSTS + `Set-Cookie: Secure` enforced in prod.
- CSRF double-submit token on every state-changing route.
- Auth events written to the existing `audit_log` table:
  `auth.sign_in`, `auth.sign_in_failed`, `auth.password_reset_requested`,
  `auth.password_changed`, `auth.role_changed`, `auth.session_revoked`.

## Open questions

1. **HIBP password check** — counts as an outside service? The
   k-anonymity API only sees a hash prefix, but it is a network
   call to a third party. Default in plan: **off**. Confirm.
2. **First-admin bootstrap** — once the env allow-list is only
   used at first-login, how does the very first admin sign in to
   a fresh DB? Plan: a `pnpm auth:bootstrap-admin --email=…`
   CLI that creates an `auth.users` row and emails a one-time
   set-password link. Confirm.
3. **MFA** — TOTP for staff is straightforward to add inside
   `lib/resupply-auth`. Ship in Stage 3 or defer? Plan: defer.
4. **Patient magic-link portal** — was the Phase 10 reason for
   choosing Clerk's passwordless support. Build it in
   `lib/resupply-auth` when Phase 10 starts; not part of this
   migration.

## File-level change summary (forward look)

Stages 1–5 will touch these key files. Useful as a checklist
during code review.

| Layer | File | Change |
|-------|------|--------|
| New package | `lib/resupply-auth/**` | Created |
| DB | `lib/resupply-db/src/schema/auth/**` | New schema files |
| DB | `lib/resupply-db/migrations/NNNN_auth.sql` | New |
| DB | `lib/resupply-db/src/schema/admin-users.ts:11` | Add `auth_user_id`, eventually drop `clerk_user_id` / `clerk_invitation_id` |
| Backend | `artifacts/api-server/src/app.ts:91` | Mount `/auth/*`, drop `clerkMiddleware()` at Stage 5 |
| Backend | `artifacts/resupply-api/src/app.ts:137` | Same |
| Backend | `artifacts/api-server/src/middlewares/requireAdmin.ts` | Replaced by `requireRole` |
| Backend | `artifacts/resupply-api/src/middlewares/requireAdmin.ts` | Replaced by `requireRole` |
| Backend | `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts` | Deleted at Stage 5 |
| Frontend | `artifacts/cpap-fitter/src/App.tsx:165` | Drop `ClerkProvider` at Stage 4 |
| Frontend | `artifacts/cpap-fitter/src/pages/sign-in.tsx` | Rewritten, no Clerk |
| Frontend | `artifacts/cpap-fitter/src/pages/sign-up.tsx` | Rewritten, no Clerk |
| Frontend | `artifacts/resupply-dashboard/src/main.tsx:28` | Drop `ClerkProvider` at Stage 3 |
| Frontend | `artifacts/resupply-dashboard/src/pages/sign-in.tsx` | Rewritten, no Clerk |
| Frontend | `artifacts/resupply-dashboard/src/pages/sign-up.tsx` | Rewritten, no Clerk |
| Shared | `lib/api-client-react/src/custom-fetch.ts:354` | Replace Clerk `getToken()` with cookie-based path + CSRF header |
| Env | `.env.example:20-22` | Drop `CLERK_*`; add `AUTH_PASSWORD_PEPPER`, `AUTH_PROVIDER` |
| Docs | `replit.md:25,37,125` | Update once Stage 5 lands |
