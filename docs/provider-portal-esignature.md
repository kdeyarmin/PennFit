# Provider e-signature portal

A secure, MFA-protected portal where ordering physicians / NPs sign in
and **e-sign** the orders, prescriptions, CMNs/DWOs, and claims that are
outstanding for **their** patients. Once a provider signs, employees
mark the item **ready-to-print**, note it **returned-signed** and
**attached to the patient chart**, and **release** the claim / item. A
printable, tamper-evident **signature log** (per document or per
provider) can be generated for Medicare / insurer audit.

Shipped behind the `provider.portal_enabled` feature flag (seeded **OFF**
across migrations `0253` + `0259`).

> This is distinct from the older, public, token-gated read-only view at
> `GET /provider-portal/:token` (which only lists a provider's active
> prescriptions). The e-signature portal is a separate, authenticated,
> MFA-gated surface.

## Identity & auth (maximum reuse)

A provider is a normal `resupply_auth.users` row with role **`customer`**
(the lowest privilege — a provider can never pass `requireAdmin`), linked
to a `resupply.providers` record via **`provider_portal_accounts`**.
"Provider-ness" is the existence of that link, not an auth role — so the
staff RBAC gate and the `auth.users.role` constraint are untouched.

This lets the portal reuse the entire in-house auth stack
(`lib/resupply-auth`): sessions (`pf_session` cookie), argon2id password
hashing, password-reset / set-password email, CSRF double-submit, and the
TOTP + recovery-code MFA primitives. A dedicated auth router is mounted at
**`/api/provider/auth`** (a third `makeAuthRouter` instance) so the portal
gets its own sign-in/out/me/forgot/reset endpoints.

### MFA is mandatory — and enforced everywhere

Provider MFA reuses the same TOTP + recovery-code engine as admin MFA, in
provider-scoped tables (`provider_mfa_secrets`,
`provider_mfa_recovery_codes`) keyed to the portal account.

The shared MFA probe in `artifacts/resupply-api/src/lib/auth-deps.ts` is
**unified**: it checks the admin tables first, then falls back to the
provider tables. This is a **security requirement**, not a convenience —
the same `AuthDeps` (and therefore the same probe) is mounted on every
`/auth` router (admin, storefront, **and** provider). If the probe only
knew about admin secrets, a provider could sign in through the storefront
mount password-only and bypass MFA. With the provider fallback wired in,
an enrolled provider is challenged for a TOTP code on **every** sign-in
surface.

A brand-new provider who hasn't enrolled is allowed through the session
gate so the SPA can route them to enrollment, but the PHI-bearing data
routes add `requireProviderMfaEnrolled`, which returns
`403 mfa_enrollment_required` until a verified secret exists.

## Signatures & the audit log

Signatures are **typed name + explicit ESIGN consent** — no drawn image
is collected. This satisfies the ESIGN Act / CMS e-signature guidance and
sidesteps the repo's "no image logging" rule entirely.

Every lifecycle action writes one row to **`provider_signature_events`**,
a feature-local, **hash-chained**, append-only log. Each event's
`event_hash = sha256(prev_hash + canonical(core))`, so a printed
certificate can show an unbroken chain. The hash math is a pure function
(`lib/provider-portal/signature-events.ts`) and is unit-tested without a
database.

> This is **not** the retired global `resupply.audit_log` machinery
> (migration 0156). It adds no readers against `audit_log`; the chain is
> scoped to producing a single printable signature certificate.

The `renderSignatureLogPdf` helper produces either a per-document
**certificate** or a per-provider **signature log**, each stating the
ESIGN/CMS attestation, the captured signer identity (typed name + NPI +
consent), the signing timestamp + IP, and the chain-integrity verdict.

## Surfaces

| Surface                                  | Where                                                           | Notes                                                           |
| ---------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Provider sign-in / MFA / queue / signing | SPA `/provider/*` (`artifacts/cpap-fitter/src/pages/provider/`) | Own lazy chunk; gated against `/api/provider/me`                |
| Provider API                             | `/api/provider/*` (`routes/provider/`)                          | `requireProvider` (+ `requireProviderMfaEnrolled` for PHI)      |
| Employee console                         | SPA `/admin/provider-portal`                                    | Invite/manage accounts, stage docs, track + release, print logs |
| Employee API                             | `/admin/provider-portal/*` (`routes/admin/provider-esign.ts`)   | `requirePermission("provider_portal.manage")` (admins + CSRs)   |

## Document lifecycle

```
(employee creates) → pending ──provider──▶ signed ──employee──▶ ready_to_print
                          │                   │                       │
                          │                   ├──▶ returned_signed     │
                       declined               ├──▶ attached_to_chart   │
                          │                   └──▶ released (claim|item)
                        void
```

`release` is intentionally **record-only**: it marks the provider's
authorization complete and clears the item for the team. It does **not**
flip `insurance_claims` state — actual 837P transmission stays in the
existing billing pipeline (no risk of corrupting claim state).

## Schema (migrations 0253 + 0259)

Split across two migrations:

- **`0253_provider_portal_esign.sql`** — the base `provider_portal_accounts`
  table (auth-user ↔ provider link; `auth_user_id` is a soft reference to
  `resupply_auth.users(id)` enforced in app code, since the migration runner
  lacks cross-schema `REFERENCES` privilege).
- **`0297_provider_portal_esign_tables.sql`** — ALTERs the lifecycle / MFA
  columns onto `provider_portal_accounts` (`status`, `mfa_enrolled_at`,
  `last_login_at`, invite/disable audit), then creates the rest:
  - `provider_mfa_secrets`, `provider_mfa_recovery_codes` — provider TOTP.
  - `provider_signature_requests` — the signable envelope + lifecycle stamps.
  - `provider_signature_events` — hash-chained append-only ceremony log.
  - seeds the `provider.portal_enabled` feature flag (OFF).

## Follow-ups (not in this PR)

- QR-code rendering on the MFA-setup screen (no QR library is bundled yet;
  the secret + `otpauth://` link are shown for manual entry).
- One-click "stage signature requests from a provider's outstanding Rx
  packets" using the existing needs-signature aggregation.
- Optional deeper chart integration (write the certificate PDF into
  `patient_documents` on attach-to-chart).
- Provider multi-device MFA (the data model supports it; the UI is
  single-device for now).
