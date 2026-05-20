# PennPaps — Production-readiness checklist

This file documents the deploy-side gates that the application code
itself can't enforce. Tick every box before flipping a public DNS
record at the resupply-api or rolling a customer-facing release.

The list is deliberately short — runtime guards already cover most
classes of misconfiguration (the `assertRequiredEnv` boot check,
`requireAdmin` failure modes). What's left is the human-in-the-loop
work an operator has to confirm once per environment.

For the first-launch procedure (the ordered run-once sequence:
generate keys → set secrets → preflight → migrate → bootstrap admin →
smoke-test), see [`runbooks/production-launch.md`](./runbooks/production-launch.md).
The `pnpm --filter @workspace/scripts preflight:prod` script validates
every required variable below in one pass.

---

## 1. Required environment variables

`assertRequiredEnv()` (in `artifacts/resupply-api/src/lib/env-check.ts`)
fails the boot if any of these are missing — but the values still
need to be **correct**, not just present.

### Auth (in-house)

- [ ] `auth.users` table has at least one row with role `admin` and
      a verified email. Seed the first admin against a fresh DB
      with `pnpm --filter @workspace/scripts auth:bootstrap-admin
--email=<addr> --role=admin`.
- [ ] No `AUTH_PASSWORD_PEPPER` env var is required. The Task #38
      follow-up removed the server-side pepper; passwords are now
      hashed with plain argon2id. Any leftover `AUTH_PASSWORD_PEPPER`
      secret from an earlier deploy is silently ignored and can be
      deleted. NB: the removal invalidated every previously stored
      password hash — existing users must go through the password
      reset flow once.

### Database

- [ ] `DATABASE_URL` — Postgres v14+ connection string. No
      extensions are required: the active resupply schema only
      uses `gen_random_uuid()`, which has been built into Postgres
      core since v13.
- [ ] All migrations applied in order:
      `pnpm --filter @workspace/resupply-db run migrate`
- [ ] Migrations 0016–0021 applied if rolling forward from before
      this PR (shop_returns, csr_macros, comm_prefs JSONB,
      review_request_sent_at, admin_users, conversations assignment).

### PHI storage

PHI columns are stored in plaintext in the resupply schema (per
migration 0025_strip_phi_encryption — see ADR 007's "Superseded"
header). Confidentiality at this layer is enforced by Postgres
authn / encryption-at-rest at the storage layer, not column-level
crypto. The only remaining application-layer secret in this family is:

- [ ] `RESUPPLY_LINK_HMAC_KEY` — 32+ random bytes used to sign the
      short-lived patient links delivered in SMS / email reminders.
      Rotating it invalidates every in-flight link.

### Admin allowlist

The role gate is DB-driven now — `requireAdmin` reads
`auth.users.role` directly (see
`artifacts/resupply-api/src/middlewares/requireAdmin.ts:21`,
"there is no env-var allowlist anymore"). The env vars listed below
are display-only and do NOT influence authorization.

- [ ] At least one row in `resupply_auth.users` with
      `role = 'admin'`. Bootstrap via
      `pnpm --filter @workspace/scripts auth:bootstrap-admin --email=<addr> --role=admin`.
- [ ] `RESUPPLY_ADMIN_EMAILS` (optional) — populates the
      "admin allowlist count" tile on `/admin/operations`. Safe to
      leave empty; auth is unaffected.
- [ ] `RESUPPLY_AGENT_EMAILS` (optional) — same posture for the CSR
      allowlist count tile.
- [ ] Subsequent admins are invited via `/admin/team` from inside the
      console once the first row exists.

### Vendors (graceful-degrade if missing — dashboard `/admin/operations`

shows green/red dots per vendor)

- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SIGNING_SECRET` — cash-pay
      shop checkout, refunds, subscription mirror. The webhook secret
      env is `STRIPE_WEBHOOK_SIGNING_SECRET` (see
      `artifacts/resupply-api/src/lib/stripe/config.ts:66`); the
      `STRIPE_WEBHOOK_SECRET` name used by an older
      `admin/system-integrations-status` field is a stale alias and
      will be removed in a follow-up.
- [ ] `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL` + `SENDGRID_FROM_NAME` —
      order receipts, reminder emails, cart-abandonment, review
      requests.
- [ ] `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` +
      `TWILIO_MESSAGING_SERVICE_SID` — outbound SMS.
- [ ] `TWILIO_VOICE_PHONE_NUMBER` — outbound voice calls.
- [ ] `ANTHROPIC_API_KEY` — Claude conversation agent.
- [ ] `OPENAI_API_KEY` — voice realtime transcription.
- [ ] `PRIVATE_OBJECT_DIR` — GCS bucket prefix for prescription
      attachments.

### Public URLs

- [ ] `SHOP_PUBLIC_BASE_URL` — used by email CTAs (cart resume,
      review request, order tracking).
- [ ] `RESUPPLY_VOICE_PUBLIC_BASE_URL` — Twilio webhook target.
- [ ] `RESUPPLY_DASHBOARD_PUBLIC_BASE_URL` — admin-team invite
      redirect URL (the link in the invitation email).

---

## 2. CORS / proxy

The API uses the in-house session cookie `pf_session` (set by
`lib/resupply-auth`, see
`lib/resupply-auth/src/cookies.ts:7`). For the customer-facing
`/account` page to talk to `/resupply-api/shop/me`, both must be
served from the **same origin** OR the proxy in front must forward
the `pf_session` cookie and respect `SameSite=Lax` / `Secure`.

- [ ] Verify the deployed proxy strips no headers between the
      cpap-fitter and the resupply-api.
- [ ] Verify the dashboard SPA and the resupply-api are co-located
      under the same hostname (or set `PENN_ALLOWED_ORIGINS` for
      explicit cross-origin allowlists).

---

## 3. TLS / HSTS

- [ ] All public hostnames behind HTTPS. The new `securityHeaders`
      middleware emits `Strict-Transport-Security` only on requests
      it recognizes as HTTPS (via `req.secure` or the
      `X-Forwarded-Proto` header), so no action needed here beyond
      "make sure you're not serving HTTP in production".

---

## 4. Logging + alerting

- [ ] Pino logs route to a long-retention sink (Datadog, CloudWatch,
      Logflare, etc).
- [ ] Alert on:
  - `event=resupply_admin_in_house_lookup_failed` (in-house auth
    lookup health — see requireAdmin)
  - `event=stripe_refund_failed`
  - `event=sms_status_update_failed`
  - any `level=fatal` line (unhandled exception, boot failure)

---

## 5. Backups + DR

- [ ] Postgres point-in-time recovery enabled.
- [ ] Object-storage bucket has versioning + lifecycle policy on
      attachments (the worker's weekly orphan-sweep at
      `13 3 * * 0` reaps unreferenced rows; lifecycle should NOT
      auto-delete referenced ones).
- [ ] Restore drill: a recent restore-to-staging exercise has
      verified the dump restores cleanly and the resupply API boots
      against it. Without that, "we have backups" is a thinkpiece,
      not a recovery plan.

---

## 6. Build / CI

- [ ] `pnpm build` runs in CI on every PR.
- [ ] `pnpm typecheck` runs in CI on every PR.
- [ ] `pnpm run lint:resupply` runs in CI on every PR.
- [ ] `pnpm --filter @workspace/resupply-api run test` runs in CI.

---

## 7. Smoke tests after deploy

- [ ] `GET /resupply-api/healthz` returns 200.
- [ ] `GET /resupply-api/readyz` returns 200 (DB pool + worker
      bootstrap succeeded).
- [ ] An invited admin can accept their email invitation, set a
      password, sign in, and reach `/admin` with their assigned role.
- [ ] An out-of-allowlist user signing in gets the
      "not authorized" page (not the "transient" one).
- [ ] The `/admin/operations` page shows GREEN dots for every
      vendor you intend to be configured.
- [ ] One smoke purchase via the shop produces a Stripe
      `checkout.session.completed` webhook landing successfully and
      a row in `shop_orders` with status=paid.

---

## 8. Privacy posture (HIPAA-adjacent)

These are already enforced by code, but a deploy-time confirmation
catches drift:

- [ ] No PHI in logs. Audit by running:
      `rg "patient\.firstName|patient\.lastName|email_address|phone" artifacts/resupply-api/src --glob="!*.test.ts" --glob="!*.md"`
      and confirming no log lines reference these fields directly.
- [ ] Audit log writes on every admin read of PHI (covered by the
      `conversation.view`, `patient.view`, `audit.export.csv` pattern;
      new admin endpoints should follow suit).
- [ ] `RESUPPLY_LINK_HMAC_KEY` rotation procedure documented (rotation
      invalidates every in-flight signed link, so coordinate with a
      send-pause window).
- [ ] Customer self-service data-export (GET /shop/me/export) is
      reachable and returns the user's complete record set.

---

## 9. Dependency hygiene

- [ ] `pnpm audit --audit-level=high` is clean (or every flagged
      advisory is documented as non-applicable in
      `pnpm.overrides` with a comment explaining why).
- [ ] No deps pinned to a major version that has been EOL'd (Node
      24, Postgres ≥ 14, etc).

---

## 10. Final pre-flight

- [ ] PR description's test plan ticked.
- [ ] All "deferred / out of scope" items in the PR description are
      tracked as follow-up tickets, not lost in commit history.
- [ ] `git tag` the commit being deployed.
