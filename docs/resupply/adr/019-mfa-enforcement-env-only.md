# ADR 019 — Admin MFA enforcement is environment-variable-only

## Context

The admin SPA has a TOTP-based MFA enrollment surface (see
`artifacts/cpap-fitter/src/pages/admin/admin-security.tsx`) and the
API backs it with the `/admin/mfa/*` route family (enroll, verify,
list devices, regenerate recovery codes, remove device). Each admin
can choose to enroll one or more authenticator apps and download a
set of single-use recovery codes.

A separate question is whether MFA is **mandatory** for every admin
or just available to those who opt in. That toggle is gated by a
single environment variable read at request time:

```ts
// artifacts/resupply-api/src/routes/admin/mfa.ts
function getEnforcementMode(): EnforcementMode {
  const v = process.env.AUTH_REQUIRE_MFA_FOR_ADMINS?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" ? "required" : "off";
}
```

When `required`, the admin shell does not hard-redirect unenrolled
admins on every nav; instead it shows a sticky MFA-enforcement
banner with an "Enroll now" link to `/admin/security` until they
finish enrollment. When `off`, enrollment stays optional and the
rest of the admin surface is reachable without MFA.

There is no admin UI to flip the toggle and no `audit_log` row
emitted when the value changes. This ADR documents that posture
and explains why we accept it.

## Decision

`AUTH_REQUIRE_MFA_FOR_ADMINS` is the single source of truth for
enforcement mode. Changing it is a deploy-time operation: an
operator with Replit secrets-access permission edits the value,
the API process restarts, and every subsequent
`/admin/mfa/status` call returns the new mode.

The audit trail for "when did MFA enforcement change?" lives in
**two** places:

1. **Replit secrets history.** The hosting layer records the
   identity of the operator who edited the secret plus the
   timestamp. This is the canonical chain-of-custody record for
   accreditation surveys.
2. **Deploy logs.** Every restart of the API logs the resolved
   enforcement mode at boot (see `getEnforcementMode` callsite).
   A grep against the deploy log gives the timestamp at which the
   new value took effect.

## Why env-var-only, not an admin route

A runtime toggle on the admin surface was the obvious alternative.
We picked env-only because:

1. **Enforcement state is policy, not data.** Whether MFA is
   mandatory is a posture decision made once per deployment
   environment, not a per-tenant or per-day operational setting.
   Putting it in the database would imply it changes frequently
   and warrants real-time visibility — neither is true.
2. **Defense against a compromised admin.** A runtime admin route
   that turns enforcement off is a sharp tool: an attacker who
   pops one admin session (somehow, while MFA is mandatory) could
   immediately disable MFA for every other admin and survive
   detection longer. Env-only adds a real-world step (Replit
   console access, distinct from API session access) between
   compromise and policy weakening.
3. **The cost of "when did this change?" is small.** Surveyors
   ask the question once per accreditation cycle. Two log /
   secret-history lookups answer it. The audit-log row we'd
   write from a runtime toggle would not add much beyond what
   the hosting layer already records.

## What this means in practice

- **Toggling enforcement** is documented in
  `docs/runbooks/production-launch.md` as part of the launch
  procedure. The same runbook covers how to read the secrets
  history when the question comes up.
- **The `/admin/operations` page** surfaces the resolved mode at
  the top of the security section so on-call CSRs can see at a
  glance whether MFA is mandatory. The page reads
  `/admin/mfa/enforcement-mode` which is the same env-var resolver.
- **No SPA write surface exists** for this setting. The
  `/admin/security` page lets an individual admin enroll/remove
  devices but cannot change the global enforcement mode.

## Future considerations

If we ever need per-role enforcement (e.g., "compliance_officer
requires MFA but agent does not"), the env-var approach breaks
down — a single boolean can't carry that nuance. At that point the
correct migration is:

1. Add a `resupply.security_settings` singleton table with one
   row per environment.
2. Add an admin route (`PATCH /admin/security/policy`) that
   writes the row + emits a `security.policy.changed` audit row
   with `old_value` / `new_value` metadata.
3. Migrate `getEnforcementMode()` to read from the table with the
   env var as a deploy-time bootstrap default.

Until that requirement materializes the env-var posture is the
right trade-off.

## Related

- `artifacts/resupply-api/src/routes/admin/mfa.ts` — enrollment + status routes.
- `docs/runbooks/production-launch.md` — operator procedure.
- ADR 014 — in-house auth (broader context for why we own this surface).
- `docs/app-review-2026-05-13.md` finding N5 — the surveyor question this ADR answers.
