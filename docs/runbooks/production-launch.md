# Production launch runbook

The deploy-side steps that have to happen once, in order, before flipping
public DNS at `pennpaps.com` for the first time. This runbook is paired
with the broader `docs/PRODUCTION_READINESS.md` checklist: that file
catalogues every gate; this one is the procedure.

Five items, all operator-only. Code can't execute them — they all need
production secret-store access and live database credentials.

| # | Step                                                                      | Where it runs                          | Section |
| - | ------------------------------------------------------------------------- | -------------------------------------- | ------- |
| 0 | Generate fresh HMAC keys                                                  | Your laptop                            | [§1](#1-generate-fresh-hmac-keys-2-min)              |
| 1 | Set every production secret in the deploy target's secret store           | Railway dashboard → service → Variables | [§2](#2-set-every-production-secret-5-min)              |
| 2 | Run `preflight:prod` against the loaded env                               | A shell inside the deploy target       | [§3](#3-run-preflightprod-90-s)              |
| 3 | Apply pending migrations against the production Supabase database         | Your laptop, pointed at prod creds     | [§4](#4-apply-migrations-against-the-production-db-5-min)              |
| 4 | Bootstrap the first admin user                                            | Your laptop, pointed at prod creds     | [§5](#5-bootstrap-the-first-admin-3-min)              |
| 5 | Restart the API + run post-deploy smoke tests                             | Railway dashboard → service → Redeploy | [§6](#6-restart-and-smoke-test-5-min)              |

Total wall-clock once you have the credentials in hand: ~20 minutes.

---

## 1. Generate fresh HMAC keys (2 min)

One HMAC key must rotate to a production-only value before launch.
It is required at boot of `resupply-api`; see `lib/resupply-secrets`.

```bash
# Run on your laptop. Produces a fresh 48-byte random value
# (64 chars of base64).
openssl rand -base64 48   # → RESUPPLY_LINK_HMAC_KEY
```

Notes:

- **Never log, paste in chat, or commit this value.** It goes directly
  into the secret store in §2.
- **Single-key only.** Rotating it invalidates in-flight signed
  artifacts; this is a non-issue on first launch (nothing in flight) but
  is non-trivial later. The link-key rotation procedure for an
  already-live system is in
  [`docs/runbooks/link-hmac-key-rotation.md`](./link-hmac-key-rotation.md).
- The link key MUST decode to ≥ 32 bytes. `openssl rand -base64 48`
  produces 48 bytes; comfortably above the minimum.
- `RESUPPLY_AUDIT_HMAC_KEY` is **no longer required**. The HIPAA
  §164.312(b) tamper-evident audit chain has been retired and no code
  path reads the key; any stale value in the secret store is ignored.

---

## 2. Set every production secret (5 min)

Open the Railway dashboard → the `resupply-api` service → Variables
and confirm every variable below is set to its production value. The
list mirrors `artifacts/resupply-api/src/lib/env-check.ts`
(required-at-boot) plus the vendor keys called out by name in the
launch brief.

### Required at boot — `resupply-api` will not start without these

| Variable                     | Production value                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `PORT`                       | The port the deployment listens on (Railway sets this automatically).             |
| `DATABASE_URL`               | `postgres://…` pointing at the production Supabase database, NOT a test branch.  |
| `SUPABASE_URL`               | The production project's API URL from Supabase → Project Settings → API.          |
| `SUPABASE_SERVICE_ROLE_KEY`  | Service-role JWT from the same page. Bypasses RLS — never expose client-side.    |
| `RESUPPLY_LINK_HMAC_KEY`     | `openssl` output from §1.                                                          |
| `RESUPPLY_ALLOWED_ORIGINS` **or** `RAILWAY_PUBLIC_DOMAIN` | Comma-separated hostnames (origin form for the first, bare-host for the second) that the CORS allowlist trusts. On Railway deployments `RAILWAY_PUBLIC_DOMAIN` is auto-populated; on any other host you must set `RESUPPLY_ALLOWED_ORIGINS`. With both empty in `NODE_ENV=production` the API throws at boot — `artifacts/resupply-api/src/app.ts:85`. |

These five (plus the CORS-allowlist gate) are what
`assertRequiredEnv()` + the CORS sanity check
(`artifacts/resupply-api/src/lib/env-check.ts` and
`artifacts/resupply-api/src/app.ts:63`) enforce at boot; the API
fails to start if any is missing.

#### Supabase Studio one-time config

Setting `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` isn't
sufficient on its own — the resupply schemas have to be exposed
to PostgREST or every Supabase-JS query at boot fails with
`schema must be one of: public`. In **Supabase Studio → Project
Settings → API → "Exposed schemas"**, confirm both `resupply` and
`resupply_auth` are listed. This is a one-time setup per project.

### Vendor secrets — production credentials, not test

| Variable                          | Production value                                                          |
| --------------------------------- | ------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`               | `sk_live_…` (NOT `sk_test_…`). Stripe Dashboard → Developers → API keys → live mode. |
| `STRIPE_WEBHOOK_SIGNING_SECRET`   | `whsec_…` from the production webhook endpoint (`https://pennpaps.com/resupply-api/webhooks/stripe`). |
| `SENDGRID_API_KEY`                | Production `SG.…` key with Mail Send + Event Webhook scopes.              |
| `TWILIO_ACCOUNT_SID`              | Production `AC…` SID (not the trial account).                             |
| `TWILIO_AUTH_TOKEN`               | Production auth token from the same Twilio sub-account.                   |

### Public URLs — every URL is HTTPS and points at `pennpaps.com`

| Variable                              | Production value                                                          |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `SHOP_PUBLIC_BASE_URL`                | `https://pennpaps.com`                                                    |
| `REMINDER_PUBLIC_BASE_URL`            | `https://pennpaps.com` (or a subdomain if the reminder host is separate). |
| `RESUPPLY_VOICE_PUBLIC_BASE_URL`      | `https://pennpaps.com` — Twilio webhook target.                           |
| `RESUPPLY_DASHBOARD_PUBLIC_BASE_URL`  | `https://pennpaps.com` (admin SPA is co-located with the storefront).     |
| `PENN_ADMIN_PUBLIC_BASE_URL`          | `https://pennpaps.com`                                                    |
| `SENDGRID_FROM_EMAIL`                 | `info@pennpaps.com` — the only From address (CLAUDE.md "One From" invariant). |

### Feature flag — turn the abandoned-fitter nudge ON

| Variable                              | Production value                                                          |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `RESUPPLY_FITTER_REENGAGE_ENABLED`    | `1`. Default is `0` so a credentialed staging deploy can't email production patients; flip to `1` at launch. The check lives at `artifacts/resupply-api/src/worker/jobs/fitter-lead-reengage.ts:300`. |

### Stale secrets — remove if present

These are no longer read by any code path. If your secret store still
carries them from a previous deploy, delete the entries so future
on-call doesn't think they're load-bearing.

| Variable                       | Why it's stale                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| `AUTH_PASSWORD_PEPPER`         | Task #38 removed the server-side pepper. Stale value silently ignored. |
| `RESUPPLY_MASTER_KEY`          | Migration 0025 stripped pgcrypto encryption. Stale value silently ignored. |
| `RESUPPLY_DATA_KEY`            | Migration 0025 stripped pgcrypto encryption. Stale value silently ignored. |
| `RESUPPLY_PHONE_HMAC_KEY`      | Migration 0025 dropped `phone_lookup`. Stale value silently ignored.   |

The full env catalogue (including the optional / feature-gated vars that
degrade gracefully) is in [`.env.example`](../../.env.example) and
[`README.md`](../../README.md#environment-variables).

---

## 3. Run `preflight:prod` (90 s)

Production secrets in place — confirm the shape before booting the API.

Two ways to run it:

**From a shell inside the deploy target (recommended).** A `railway
run` shell against the production environment loads the service's
Variables into `process.env`, mirroring what `resupply-api` will see
at boot.

```bash
pnpm --filter @workspace/scripts preflight:prod
```

**From your laptop against an exported env file.** Useful for a
pre-flight before you've pushed the secrets to Railway.

```bash
# Drop the production secrets you intend to push into an env file
# (KEY=value per line) — .env*.production* is git-ignored. The
# `pnpm exec` wrapper puts the scripts package's tsx binary on
# PATH for the inner `node` so --import=tsx resolves cleanly;
# --env-file is a Node 20.6+ builtin that loads the file into
# process.env for the subprocess only.
pnpm --filter @workspace/scripts exec \
  node --env-file=$(pwd)/.env.production-candidate \
       --import=tsx ./src/preflight-prod-env.ts
```

Expected output: `Ready for launch.` with no FAILs. The exit code is
0 as long as no FAILs remain — WARNs are advisory, not gating, but
every WARN should be read and consciously dismissed:

- `RESUPPLY_FITTER_REENGAGE_ENABLED != 1` — the abandoned-fitter
  re-engagement cron will not run. Acceptable for a soft-launch
  ("ship without the nudge"); not acceptable if the brief says the
  nudge is part of launch. Flip the flag and re-run.
- `RESUPPLY_ADMIN_EMAILS` empty — only affects the
  `/admin/operations` allowlist-count display tile. The auth gate
  reads `auth.users.role` from the DB; the bootstrap step in §5 is
  what actually creates the first admin row.
- Stale-secret warnings (`AUTH_PASSWORD_PEPPER`, the
  `RESUPPLY_MASTER_KEY` family) — silently ignored at runtime; the
  WARN is a prompt to prune the secret store, not a launch gate.
- `STRIPE_WEBHOOK_SECRET` set alongside the canonical
  `STRIPE_WEBHOOK_SIGNING_SECRET` — only the latter is consulted
  by the webhook handler. The legacy name is read in one
  `/admin/operations` display tile and is otherwise dead. Delete
  the legacy entry from the secret store after launch.

What the script does NOT cover: it does not hit Postgres, Supabase,
Stripe, SendGrid, or Twilio. A credential that's correctly shaped but
revoked still passes. Live-wire failures surface in §6.

---

## 4. Apply migrations against the production DB (5 min)

The migrator is `pnpm --filter @workspace/resupply-db run migrate`. It
applies every pending SQL file in `lib/resupply-db/drizzle/`, takes a
Postgres advisory lock for the duration so two deploys can't race, and
records every applied file in `drizzle.resupply_migrations`.

Copy the production Postgres connection string from Supabase →
Project Settings → Database (the "Connection string" / "Direct
connection" entry, NOT a Supabase branch URL) and export it as
`DATABASE_URL` in the same shell before running the migrator. The
migrator only reads `DATABASE_URL`; `SUPABASE_*` is not consulted on
this step.

```bash
# Paste the production connection string after the equals sign, then
# run the migrator. The migrator is idempotent — re-running with no
# pending files is a no-op.
export DATABASE_URL=
pnpm --filter @workspace/resupply-db run migrate
```

What you should see:

- One line per migration applied, with the SQL filename and ms taken.
- A final "migrations up to date" line (or equivalent for the apply phase).
- Exit code 0.

If it fails:

- **Exit 2** — `DATABASE_URL` not set. Re-export and retry.
- **Connection error** — wrong host, wrong creds, IP not allow-listed.
  The migrator already retries transient errors (`ECONNREFUSED`,
  `ETIMEDOUT`, `57P03`) with exponential backoff; a non-transient
  failure surfaces immediately.
- **Statement error inside a migration** — every pending migration in
  the batch runs inside a single `BEGIN`/`COMMIT` transaction
  (see `lib/resupply-db/scripts/migrate.mjs:189`), so any statement
  failure rolls the entire batch back. The DB is left exactly as it
  was before the migrator ran; nothing partial lands. Fix the
  offending SQL in `lib/resupply-db/drizzle/<tag>.sql`, push, and
  re-run — the prior migrations are still considered "to apply" and
  will replay cleanly.

Migration-history details: [ADR 003 / migration-state-investigation](../migration-state-investigation-2026-05-08.md).

---

## 5. Bootstrap the first admin (3 min)

A fresh `resupply_auth.users` table has zero rows. Without one, no human
can sign into `/admin/sign-in` — the admin SPA gates on
`useGetAdminMe`. The bootstrap script in `scripts/src/auth-bootstrap-admin.ts`
inserts the first row, issues a 1-hour password-reset token, and (when
SendGrid is configured) emails a set-password link to the new admin.

Fill in the four shell variables below with the production values
(Supabase URL, service-role JWT, and the email of the human who will
own the first admin row). `SHOP_PUBLIC_BASE_URL` and
`SENDGRID_FROM_EMAIL` are already concrete; copy them as-is.
`SENDGRID_API_KEY` is optional — without it the script prints the
reset link to stdout for the operator to relay manually.

```bash
# Fill in: production Supabase URL + service-role JWT (Supabase →
# Project Settings → API), and the address of the first admin
# (any address — requireAdmin reads the role from auth.users, so no
# env-var allowlist needs to be updated alongside).
export SUPABASE_URL=
export SUPABASE_SERVICE_ROLE_KEY=
FIRST_ADMIN_EMAIL=

# Already concrete production values — copy as-is.
export SHOP_PUBLIC_BASE_URL="https://pennpaps.com"
export SENDGRID_FROM_EMAIL="info@pennpaps.com"

# Optional: paste the production SendGrid key to deliver the
# password-reset email automatically. Leave blank to print the link.
export SENDGRID_API_KEY=

pnpm --filter @workspace/scripts auth:bootstrap-admin \
  --email="$FIRST_ADMIN_EMAIL" \
  --role=admin
```

What you should see (one line each):

- A "Bootstrap link (valid 1 hour)" line containing
  `https://pennpaps.com/admin/reset-password?token=…`.
- Either "Email sent to …" (when SendGrid is configured) or a
  SendGrid-not-configured notice telling the operator to use the
  printed link.
- A final "Done. user=… role=admin status=invited" confirmation.

Then:

1. The new admin opens the email (or the printed link), sets a
   password, lands on `/admin`.
2. Subsequent admins are invited via `/admin/team` from inside the
   console — the script is only needed to break the chicken-and-egg.

Caveats:

- The admin gate is DB-driven now: `requireAdmin` reads
  `auth.users.role` directly (see
  `artifacts/resupply-api/src/middlewares/requireAdmin.ts:21`,
  "there is no env-var allowlist anymore"). Once the bootstrap
  inserts the row, the new admin can sign in immediately; no
  `RESUPPLY_ADMIN_EMAILS` update or API restart is needed.
- For the rare case where the first admin needs to be an agent (role
  `agent`), pass `--role=agent` instead. Re-running with `--force`
  upgrades an existing row.

---

## 6. Restart and smoke-test (5 min)

Trigger a deploy / restart so the new env values take effect, then
walk the smoke-test list.

```text
Railway dashboard → service → Redeploy   (or push to main, depending on your wiring)
```

Smoke tests — every one of these should pass before you announce the
launch. Start with the automated reachability gate, which catches the
single most common deploy regression: the public domain serving the
SPA but **not** routing `/resupply-api/*` to a live API process (every
JSON API call then 404s and the shop page shows "Failed to load shop
products (404)").

- [ ] `pnpm --filter @workspace/scripts verify:deploy -- https://pennpaps.com`
      exits `0`. It asserts `/resupply-api/healthz` and
      `/resupply-api/shop/products` return real JSON (not a `404`, not
      the SPA HTML shell) and that `/` serves the SPA. A FAIL with
      "the API tree is NOT mounted on this host" means the domain is
      bound to a static / SPA-only service instead of the single
      Express service defined by `railway.json`'s `startCommand` —
      rebind the domain to that service and redeploy.
- [ ] `GET https://pennpaps.com/resupply-api/healthz` → `200` JSON
      `{"status":"ok"}`. This is also Railway's configured health
      check (liveness): it touches no dependency, so the process
      reports healthy as soon as it is serving — a DB/queue hiccup at
      boot can no longer blackhole the entire site behind a failing
      health check.
- [ ] `GET https://pennpaps.com/resupply-api/readyz` → `200`. This
      confirms the Supabase client AND the in-process worker booted.
      Unlike `/healthz`, `/readyz` returns `503` while the DB or the
      pg-boss worker is down — that is now a monitoring / alerting
      signal, **not** a deploy gate. The worker retries in the
      background and the public storefront keeps serving the Stripe
      catalog meanwhile.
- [ ] The bootstrap admin from §5 can complete `/admin/reset-password`,
      sign in at `/admin/sign-in`, and reach `/admin` with the
      `admin` role.
- [ ] `/admin/operations` shows GREEN dots for Stripe, SendGrid,
      Twilio. Red dots here mean a credential is wrong or missing —
      compare against §2 and rotate as needed.
- [ ] A user without an `admin`/`agent` row in `auth.users` who tries
      to reach `/admin` is rejected with 401 ("Sign in required") or
      403 ("not authorized"), NOT the generic "transient" error.
      The gate is the DB role — see
      `artifacts/resupply-api/src/middlewares/requireAdmin.ts`.
- [ ] One real test purchase via the storefront produces a Stripe
      `checkout.session.completed` webhook and a row in
      `shop_orders` with `status=paid`. (Use a real card with a small
      refundable amount; immediately refund via Stripe Dashboard.)
- [ ] One reminder email arrives at a test inbox with all CTA links
      pointing at `https://pennpaps.com/…` and verifying cleanly.
- [ ] No `level=fatal` lines in the Pino log tail; no
      `event=resupply_admin_in_house_lookup_failed`.

If any smoke test fails:

- Re-read `docs/PRODUCTION_READINESS.md` §6–§7 — that file documents
  the broader CI / smoke matrix and the alerting hooks.
- For HMAC-key-related failures (links report
  `bad-signature`), see
  [`docs/runbooks/link-hmac-key-rotation.md`](./link-hmac-key-rotation.md).
- For worker queue failures (`pgboss_jobs_failed` ticks up), see
  [`docs/runbooks/worker-recovery.md`](./worker-recovery.md).

---

## After launch

- Tag the deployed commit: `git tag "prod-launch-$(date -u +%Y-%m-%d)" && git push --tags`.
- Confirm Postgres point-in-time recovery is enabled on the production
  Supabase project (PRODUCTION_READINESS.md §5).
- Schedule the first restore-to-staging drill — backups you haven't
  restored are a thinkpiece, not a recovery plan.
- File a follow-up to add dual-key support to the link HMAC if you
  expect to rotate the key while the system is live — the rotation
  runbook calls out the gap.

---

## Cross-references

- [`docs/PRODUCTION_READINESS.md`](../PRODUCTION_READINESS.md) — full
  pre-flight checklist (TLS, CORS, logging, dependency hygiene).
- [`docs/runbooks/link-hmac-key-rotation.md`](./link-hmac-key-rotation.md)
  — rotating the link key on a live system.
- [`docs/runbooks/worker-recovery.md`](./worker-recovery.md) — what to
  do when pg-boss queues back up.
- [`.env.example`](../../.env.example) — every variable, including
  the optional / feature-gated ones not listed above.
- [`README.md`](../../README.md#environment-variables) — human-facing
  setup guide.
- `scripts/src/preflight-prod-env.ts` — the source of every check the
  preflight performs. If a check fires false positives, edit the file
  here, not the runbook.
