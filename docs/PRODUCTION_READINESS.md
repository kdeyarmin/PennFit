# PennPaps — Production-readiness checklist

This file documents the deploy-side gates that the application code
itself can't enforce. Tick every box before flipping a public DNS
record at the resupply-api or rolling a customer-facing release.

The list is deliberately short — runtime guards already cover most
classes of misconfiguration (the `assertRequiredEnv` boot check,
`assertPgcryptoEnabled` preflight, `requireAdmin` failure modes).
What's left is the human-in-the-loop work an operator has to confirm
once per environment.

---

## 1. Required environment variables

`assertRequiredEnv()` (in `artifacts/resupply-api/src/lib/env-check.ts`)
fails the boot if any of these are missing — but the values still
need to be **correct**, not just present.

### Auth (in-house)

- [ ] `AUTH_PASSWORD_PEPPER` — 32+ random bytes (base64). Mixed into
      argon2id when hashing customer passwords; bcrypt is only the
      legacy Clerk import path. Treat as long-lived; rotating it
      invalidates every stored hash.
- [ ] `AUTH_SESSION_TTL_DAYS` (default 14), `AUTH_EMAIL_TOKEN_TTL_HOURS`
      (default 24) — session and verify/reset link lifetimes. Defaults
      are fine for production unless a security review says otherwise.

### Database

- [ ] `DATABASE_URL` — Postgres connection string with the `pgcrypto`
      extension installed. The boot will fail with
      `PgcryptoNotInstalledError` if the extension is missing.
- [ ] All migrations applied in order:
      `pnpm --filter @workspace/resupply-db run migrate`. The migrator
      is idempotent (already-applied migrations are tracked in
      `drizzle.resupply_migrations`), so re-running on a current
      deploy is a no-op.

### PHI encryption

- [ ] `RESUPPLY_MASTER_KEY` — single 32+ byte secret; the resupply
      stack HKDF-derives bulk PHI encryption (pgcrypto), email link
      HMAC, and phone-lookup HMAC subkeys from it with distinct
      domain-separated `info` labels. Lost = unrecoverable PHI;
      rotation requires the `rotate-to-master-key` script.
- [ ] (Legacy) `RESUPPLY_DATA_KEY`, `RESUPPLY_LINK_HMAC_KEY`,
      `RESUPPLY_PHONE_HMAC_KEY` — older deployments may still set
      these explicitly; each takes precedence over the master-derived
      value for that purpose, so encrypted PHI written under a legacy
      key keeps decrypting after `RESUPPLY_MASTER_KEY` is added.

### Admin access

Stage 5b moved admin/agent role authority onto `auth.users.role`
(DB-backed). The legacy `RESUPPLY_ADMIN_EMAILS` /
`RESUPPLY_AGENT_EMAILS` env vars are no longer consulted by
`requireAdmin` — they survive only as display values on the
`/admin/settings` panel (and as the `RESUPPLY_ADMIN_EMAILS` userenv
hint on Replit).

- [ ] At least one row exists in `auth.users` with
      `role = 'admin'` and `status = 'active'`. Seed the first one
      with `pnpm --filter @workspace/scripts auth:bootstrap-admin
      --email=<addr> --role=admin` against the production
      `DATABASE_URL`. The script issues a one-time set-password
      email (when SendGrid is configured) and prints the raw token
      so the bootstrap admin can sign in.
- [ ] Additional admins / agents are added via `/admin/team` in
      the resupply dashboard, NOT through env-var edits.

### Vendors (graceful-degrade if missing — dashboard `/admin/operations`
shows green/red dots per vendor)

- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SIGNING_SECRET` — cash-pay
      shop checkout, refunds, subscription mirror. Webhook signature
      verification fails closed without the signing secret.
- [ ] `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL` + `SENDGRID_FROM_NAME` —
      order receipts, reminder emails, cart-abandonment, review
      requests.
- [ ] `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` — verifies SendGrid event
      webhook signatures so bounce / spam-report events are trusted.
- [ ] `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` +
      `TWILIO_MESSAGING_SERVICE_SID` — outbound SMS.
- [ ] `TWILIO_PHONE_NUMBER` — outbound voice calls and SMS fallback
      when no messaging service is configured.
- [ ] `OPENAI_API_KEY` — conversation AI + voice realtime transcription.
- [ ] `PRIVATE_OBJECT_DIR` — GCS bucket prefix for prescription
      attachments.

### Public URLs

- [ ] `SHOP_PUBLIC_BASE_URL` — used by email CTAs (cart resume,
      review request, order tracking).
- [ ] `RESUPPLY_VOICE_PUBLIC_BASE_URL` — Twilio webhook target.
- [ ] `RESUPPLY_DASHBOARD_PUBLIC_BASE_URL` — admin-team invite
      redirect URL (the link in admin invitation emails).
- [ ] `PENN_ADMIN_PUBLIC_BASE_URL` — public origin of the PennPaps
      admin console; used to build links in admin-only emails.
- [ ] `RESUPPLY_PUBLIC_BASE_URL` — public origin used for Stripe
      Checkout success/cancel redirects. Falls back to
      `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN` when unset.

---

## 2. CORS / proxy

The API has no `credentials: include` CORS policy — it requires
Bearer tokens, deliberately. For the customer-facing `/account` page
to talk to `/resupply-api/shop/me`, both must be served from the
**same origin** OR the proxy in front must forward the auth-provider
session cookie (`__session`) and respect SameSite=Lax / Secure.

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
  - `event=resupply_admin_clerk_lookup_failed` (Clerk Backend API
    health)
  - `event=stripe_refund_failed`
  - `event=sms_status_update_failed`
  - any `level=fatal` line (unhandled exception, pgcrypto missing,
    boot failure)

---

## 5. Backups + DR

- [ ] Postgres point-in-time recovery enabled.
- [ ] Object-storage bucket has versioning + lifecycle policy on
      attachments (the worker's weekly orphan-sweep at
      `13 3 * * 0` reaps unreferenced rows; lifecycle should NOT
      auto-delete referenced ones).
- [ ] Restore drill: a recent restore-to-staging exercise has
      verified `RESUPPLY_PHI_ENCRYPTION_KEY` decrypts the backup.
      Without that, "we have backups" is a thinkpiece, not a recovery
      plan.

---

## 6. Build / CI

- [ ] `pnpm build` runs in CI on every PR.
- [ ] `pnpm typecheck` runs in CI on every PR.
- [ ] `pnpm run lint:resupply` runs in CI on every PR.
- [ ] `pnpm --filter @workspace/resupply-api run test` runs in CI.

---

## 7. Smoke tests after deploy

- [ ] `GET /resupply-api/healthz` returns 200.
- [ ] `GET /resupply-api/readyz` returns 200 (preflight succeeded).
- [ ] An invited admin can sign up via Clerk magic link, sign in,
      and reach `/admin` with their assigned role.
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
- [ ] Audit log writes on every admin read of decrypted PHI (covered
      by the `conversation.view`, `patient.view`, `audit.export.csv`
      pattern; new admin endpoints should follow suit).
- [ ] `RESUPPLY_PHI_ENCRYPTION_KEY` rotation procedure documented
      and tested in staging.
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
