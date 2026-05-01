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

### Auth (Clerk)

- [ ] `CLERK_SECRET_KEY` — backend secret key for the SAME Clerk app
      the publishable key on every frontend points at. A mismatched
      app will pass `getAuth(req).userId` but fail
      `clerkClient.users.getUser(userId)` with "user not found".
- [ ] `VITE_CLERK_PUBLISHABLE_KEY` — set on the cpap-fitter and
      resupply-dashboard frontends.
- [ ] **Clerk dashboard → Sessions → Customize session token** — add
      `email` (or `primary_email_address`) to the JWT claims so the
      `requireAdmin` middleware can read the email from the session
      JWT directly. With this set, the dashboard survives Clerk
      Backend API outages without locking admins out.

### Database

- [ ] `DATABASE_URL` — Postgres connection string with the `pgcrypto`
      extension installed. The boot will fail with
      `PgcryptoNotInstalledError` if the extension is missing.
- [ ] All migrations applied in order:
      `pnpm --filter @workspace/resupply-db run migrate`
- [ ] Migrations 0016–0021 applied if rolling forward from before
      this PR (shop_returns, csr_macros, comm_prefs JSONB,
      review_request_sent_at, admin_users, conversations assignment).

### PHI encryption

- [ ] `RESUPPLY_PHI_ENCRYPTION_KEY` — never rotated without a
      coordinated re-encryption pass; lost = unrecoverable PHI.
- [ ] `RESUPPLY_PHONE_HMAC_KEY` — must be DIFFERENT from
      `RESUPPLY_PHI_ENCRYPTION_KEY` (separate compromise paths per
      ADR 009).

### Admin allowlist

- [ ] `RESUPPLY_ADMIN_EMAILS` — comma-separated allowlist. At least
      ONE entry is required; `requireAdmin` 503s on every request
      when this is empty in `NODE_ENV=production`.
- [ ] `RESUPPLY_AGENT_EMAILS` — optional allowlist for CSRs.
- [ ] DB-backed members (added via `/admin/team`) layer on top once
      migration 0020 is applied.

### Vendors (graceful-degrade if missing — dashboard `/admin/operations`
shows green/red dots per vendor)

- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` — cash-pay shop
      checkout, refunds, subscription mirror.
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
      redirect URL (the link in the Clerk-sent email).

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
