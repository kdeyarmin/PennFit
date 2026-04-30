# ADR 005 — Clerk for admin auth (not AWS Cognito)

## Context

The original plan called for AWS Cognito. The PennPaps fitter already runs Clerk and
the existing `artifacts/api-server` integrates Clerk via `@clerk/express`.

Cognito is fine but adds another vendor BAA and a second auth model in the
same monorepo.

## Decision

Use Clerk for admin authentication on the resupply dashboard, mirroring
the fitter's pattern.

- Admin allowlist: a comma-separated `RESUPPLY_ADMIN_EMAILS` env var,
  checked by a `requireAdmin` middleware against the user's
  Clerk-verified primary email.
- The middleware fails closed in production when the allowlist is unset.
- Patients are NOT given Clerk accounts. The patient self-service portal
  (Phase 10) uses passwordless email/SMS magic-link auth that Clerk
  supports natively.

The same pattern (Clerk allowlist) gates the PennPaps fitter admin dashboard, so
admins get one login for both products if they are listed in both
allowlists.

## Consequences

- One auth vendor across both products. One BAA to negotiate (Clerk
  Enterprise BAA — confirm before launch).
- If Clerk's BAA terms become unworkable, we must migrate. The
  `requireAdmin` middleware already abstracts auth, so the migration
  surface is small.

## Alternatives Considered

- **AWS Cognito** — second BAA, second integration model.
- **Self-rolled JWT auth** — rejected. Auth is hard; we are not the
  experts.
- **Replit Auth** — fine for internal tools but not appropriate for a
  HIPAA-bound admin console where we need verified email + audit
  evidence + the ability to revoke sessions on demand.

## TODO

- [BUSINESS REVIEW] Confirm Clerk Enterprise BAA before launch, or
  trigger migration to Cognito.
