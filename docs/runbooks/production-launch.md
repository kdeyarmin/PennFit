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
| 1 | Set every production secret in the deploy target's secret store           | Replit Deployments → Secrets           | [§2](#2-set-every-production-secret-5-min)              |
| 2 | Run `preflight:prod` against the loaded env                               | A shell inside the deploy target       | [§3](#3-run-preflightprod-90-s)              |
| 3 | Apply pending migrations against the production Supabase database         | Your laptop, pointed at prod creds     | [§4](#4-apply-migrations-against-the-production-db-5-min)              |
| 4 | Bootstrap the first admin user                                            | Your laptop, pointed at prod creds     | [§5](#5-bootstrap-the-first-admin-3-min)              |
| 5 | Restart the API + run post-deploy smoke tests                             | Replit Deployments → Restart           | [§6](#6-restart-and-smoke-test-5-min)              |

Total wall-clock once you have the credentials in hand: ~20 minutes.

---

## 1. Generate fresh HMAC keys (2 min)

Two HMAC keys must rotate to production-only values before launch. Both
are required at boot of `resupply-api`; see `lib/resupply-secrets`
and `lib/resupply-audit`.

```bash
# Run on your laptop. Each invocation produces a fresh 48-byte random
# value (64 chars of base64). Capture BOTH outputs.
openssl rand -base64 48   # → RESUPPLY_LINK_HMAC_KEY
openssl rand -base64 48   # → RESUPPLY_AUDIT_HMAC_KEY
```

Notes:

- **Never log, paste in chat, or commit these values.** They go directly
  into the secret store in §2.
- **Single-key only.** Rotating either invalidates in-flight signed
  artifacts; this is a non-issue on first launch (nothing in flight) but
  is non-trivial later. The link-key rotation procedure for an
  already-live system is in
  [`docs/runbooks/link-hmac-key-rotation.md`](./link-hmac-key-rotation.md).
- The audit key MUST decode to ≥ 32 bytes. `openssl rand -base64 48`
  produces 48 bytes; comfortably above the minimum.

---

## 2. Set every production secret (5 min)

Open Replit Deployments → Secrets and confirm every variable below
is set to its production value. The list mirrors
`artifacts/resupply-api/src/lib/env-check.ts` (required-at-boot) plus
the vendor keys called out by name in the launch brief.

### Required at boot — `resupply-api` will not start without these

| Variable                     | Production value                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `PORT`                       | The port the deployment listens on (Replit sets this automatically).              |
| `DATABASE_URL`               | `postgres://…` pointing at the production Supabase database, NOT a test branch.  |
| `SUPABASE_URL`               | The production project's API URL from Supabase → Project Settings → API.          |
| `SUPABASE_SERVICE_ROLE_KEY`  | Service-role JWT from the same page. Bypasses RLS — never expose client-side.    |
| `RESUPPLY_LINK_HMAC_KEY`     | First `openssl` output from §1.                                                   |
| `RESUPPLY_AUDIT_HMAC_KEY`    | Second `openssl` output from §1.                                                  |
| `RESUPPLY_ADMIN_EMAILS`      | Comma-separated allowlist of admin emails. At least one entry is required.        |

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

**From a shell inside the deploy target (recommended).** The Replit
deployment's secret store is already loaded into the shell, so
`process.env` mirrors what `resupply-api` will see at boot.

```bash
pnpm --filter @workspace/scripts preflight:prod
```

**From your laptop against an exported env file.** Useful for a
pre-flight before you've pushed the secrets to Replit.

```bash
# .env.production-candidate is git-ignored; export the secrets you
# intend to push, one KEY=value per line. Node v22's native flag
# loads the file into process.env for the subprocess only.
node --env-file=.env.production-candidate --import=tsx \
  scripts/src/preflight-prod-env.ts
```

Expected output: `Ready for launch.` with 0 fails and 0 warns. If any
FAIL lines remain, fix them before continuing. If WARN lines remain,
read each carefully — most signal stale state in the secret store and
do not block launch, but `RESUPPLY_FITTER_REENGAGE_ENABLED!=1` is the
one warning that does.

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
- **Partial apply** — the advisory lock + per-statement transaction
  means a crashed migration leaves the prior rows applied and the
  current row not in `drizzle.resupply_migrations`. Re-running picks
  up exactly where it left off.

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
# Project Settings → API), and the address of the first admin (must
# also be present in RESUPPLY_ADMIN_EMAILS from §2).
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

- The script REQUIRES the email passed in `--email` to also be in
  `RESUPPLY_ADMIN_EMAILS` (set in §2). If it isn't, the row is
  inserted with `role=admin` but `requireAdmin` rejects the session
  because the env-allowlist gate fires before the DB role check.
  Adding the email to the env var and restarting the API is the fix.
- For the rare case where the first admin needs to be an agent (role
  `agent`), pass `--role=agent` instead. Re-running with `--force`
  upgrades an existing row.

---

## 6. Restart and smoke-test (5 min)

Trigger a deploy / restart so the new env values take effect, then
walk the smoke-test list.

```text
Replit Deployments → Restart   (or push to main, depending on your wiring)
```

Smoke tests — every one of these should pass before you announce the
launch:

- [ ] `GET https://pennpaps.com/resupply-api/healthz` → `200`.
- [ ] `GET https://pennpaps.com/resupply-api/readyz` → `200`. This
      confirms the DB pool, Supabase client, and the in-process worker
      all booted.
- [ ] The bootstrap admin from §5 can complete `/admin/reset-password`,
      sign in at `/admin/sign-in`, and reach `/admin` with the
      `admin` role.
- [ ] `/admin/operations` shows GREEN dots for Stripe, SendGrid,
      Twilio. Red dots here mean a credential is wrong or missing —
      compare against §2 and rotate as needed.
- [ ] An out-of-allowlist email signing in lands on the
      "not authorized" page (not the generic "transient" error).
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
