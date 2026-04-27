# ADR 000 — Replit-driven deviations from the original build plan

## Context

The original CPAP Resupply Automation plan was written for an enterprise AWS
deployment: ECS Fargate, RDS, ElastiCache (Redis), Temporal, AWS KMS, AWS
Cognito, Datadog/Honeycomb, NestJS, Prisma, Turborepo, Docker Compose for
local dev, Mailhog for email capture, Husky pre-commit hooks, GitHub Actions
for CI.

This product is being prototyped on Replit. Replit cannot host every piece of
that stack as-is. Rather than pretend otherwise, this meta-ADR documents which
parts were substituted, why, and how each substitution will be revisited
before any BAA-bound launch.

## Decision

The following substitutions are made for the Phase 0 build:

| Original plan | Replit substitute | Migration trigger | ADR |
|---|---|---|---|
| NestJS | Express + Zod (matches existing api-server) | Re-evaluate at Phase 8 if DI/decorator boilerplate becomes painful | 001 |
| Prisma | Drizzle (matches existing `lib/db`) | Stay with Drizzle long-term | 003 |
| Temporal | pg-boss (Postgres-backed jobs + state-machine workflows in DB) | Move to Temporal at production hosting if multi-day workflow visibility becomes a real need | 002 |
| AWS KMS | pgcrypto + `RESUPPLY_DATA_KEY` env var as KEK | Rotate to a managed KMS (AWS KMS, GCP KMS, or HashiCorp Vault) before signing any vendor BAA | 007 |
| AWS Cognito | Clerk (matches existing Penn Fit pattern, BAA available on enterprise) | Confirm Clerk enterprise BAA before launch; otherwise migrate to Cognito | 005 |
| Datadog / Honeycomb / Sentry | Pino structured logs (stdout) for v1; Sentry (BAA) added later | Add Sentry before Phase 9 production hardening | (no dedicated ADR; see ARCHITECTURE.md "Observability") |
| Twilio (SMS / Voice / SendGrid) | Twilio (unchanged — Twilio runs fine from Replit, BAA required) | — | 004 |
| Anthropic Claude | Anthropic Claude (unchanged — BAA required before any PHI in prompts) | — | 006 |
| Docker Compose | Replit-managed Postgres; pg-boss replaces Redis; SendGrid sandbox replaces Mailhog | — | 010 |
| Turborepo | pnpm workspaces (already in place) | — | 012 |
| Husky / lint-staged | Replit "validation steps" run on demand and before deploy | — | 012 |
| GitHub Actions | Replit deploy gate uses the same validation steps | Add real GH Actions if the project leaves Replit | 012 |
| Next.js operator dashboard | React + Vite (matches the Replit scaffold and the existing OpenAPI codegen pipeline) | — | 011 |

## Consequences

- The development experience is simpler (no Docker, no separate Temporal
  server) but two pieces — durable orchestration and managed KMS — must be
  revisited before launch. They are flagged in ADR 002 and ADR 007.
- All PHI-touching code is built against ports/adapters so the substitutions
  above can be swapped without rewriting domain logic.
- Each substitute lists its migration trigger so Phase 9 (production
  hardening) has a concrete checklist instead of a vibe.

## Alternatives Considered

- **Build the original stack on a different cloud now.** Rejected for Phase 0
  — it would block all later phases on infrastructure work the user did not
  ask for. The plan specifies "build, then harden" and the substitutes are
  reversible.
- **Refuse to start until BAAs and AWS are in place.** Rejected — the user
  explicitly chose to begin building. Hard gates (BAAs, 10DLC, counsel
  review) are documented in the original plan and remain blockers for
  go-live, not for prototyping.

## TODO (business)

- [BUSINESS REVIEW] Confirm willingness to migrate hosting to AWS (or
  equivalent) before any patient PHI hits this system in production.
- [ATTORNEY REVIEW] Confirm that prototyping with synthetic data on Replit
  during Phase 0–8 is acceptable. No real patient data should be loaded
  until the migration triggers above have fired.
