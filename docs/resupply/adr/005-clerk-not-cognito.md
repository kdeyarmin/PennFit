# ADR 005 — Clerk for admin auth (not AWS Cognito)

> **Status: Superseded by [ADR 014 — In-house authentication](./014-in-house-auth.md).**
>
> The decision to use Clerk has been reversed. Authentication for both
> staff and customers is being moved fully in-house. The HIPAA BAA
> framing in the original "Consequences" / "Alternatives" sections is
> no longer a constraint on this choice. See ADR 014 for the new
> direction and `docs/resupply/AUTH-MIGRATION-PLAN.md` for the
> staged rollout.
>
> The text below is preserved for historical context only.

## Context

The original plan called for AWS Cognito. Penn Fit already runs Clerk and
the existing `artifacts/api-server` integrates Clerk via `@clerk/express`.

Cognito is fine but adds another vendor and a second auth model in the
same monorepo.

## Decision

Use Clerk for admin authentication on the resupply dashboard, mirroring
Penn Fit's pattern.

- Admin allowlist: a comma-separated `RESUPPLY_ADMIN_EMAILS` env var,
  checked by a `requireAdmin` middleware against the user's
  Clerk-verified primary email.
- The middleware fails closed in production when the allowlist is unset.
- Patients are NOT given Clerk accounts. The patient self-service portal
  (Phase 10) uses passwordless email/SMS magic-link auth that Clerk
  supports natively.

The same pattern (Clerk allowlist) gates the Penn Fit admin dashboard, so
admins get one login for both products if they are listed in both
allowlists.

## Consequences

- One auth vendor across both products.
- The `requireAdmin` middleware abstracts auth, so a future migration
  surface is small.

## Alternatives Considered

- **AWS Cognito** — second integration model.
- **Self-rolled JWT auth** — rejected at the time. (Reversed by ADR 014.)
- **Replit Auth** — fine for internal tools but not appropriate for an
  admin console where we need verified email + audit evidence + the
  ability to revoke sessions on demand.
