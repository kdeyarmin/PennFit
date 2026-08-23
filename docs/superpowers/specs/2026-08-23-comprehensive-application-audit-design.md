# Comprehensive Application Audit Design

## Objective

Perform a risk-ranked review of the entire CareMetric Breathe application,
fix every confirmed and actionable defect, add regression protection where
practical, and repeat the review until no further actionable findings remain.
The review covers the repository, both runnable applications, shared packages,
the local Supabase-backed environment, and the production deployment.

## Scope

The audit includes:

- Repository configuration, dependency health, build and deployment contracts.
- Type safety, linting, formatting, architecture rules, and automated tests.
- API behavior, authentication, authorization, tenant isolation, input
  validation, error handling, observability, queues, database access, and
  third-party integration boundaries.
- Storefront and admin UI behavior, accessibility, responsive presentation,
  loading and failure states, browser compatibility, and performance.
- Local end-to-end workflows against the repository's Supabase development
  stack.
- Production routing, health, security headers, crawlability, SEO, performance,
  public workflows, authenticated workflows, and integrations when safe test
  credentials and data are available.

The audit does not include speculative product features, broad visual redesign,
or refactoring without a concrete correctness, security, usability,
performance, or maintainability benefit.

## Audit Strategy

Work proceeds in expanding layers so inexpensive, deterministic failures are
resolved before browser and production investigation:

1. Establish repository and toolchain state, inventory applications and
   packages, and inspect recent changes and existing review documentation.
2. Run the smallest static and package-level checks first, followed by the full
   typecheck, lint, test, format-check, architecture checks, and build suite.
3. Review security- and correctness-sensitive backend paths, especially tenant
   resolution, authorization, database queries, webhooks, queues, payments,
   telecom, messaging, AI boundaries, and error handling.
4. Review frontend routes and shared components for functional bugs,
   accessibility, responsive behavior, performance, and resilient states.
5. Start the local Supabase, API, and SPA stack and exercise representative
   storefront and admin journeys with browser automation and accessibility
   checks.
6. Audit the production deployment, including a shallow then full website
   crawl when the audit tool is available, direct protocol/header probes, and
   safe workflow checks.
7. Fix findings in risk order, add focused regression coverage, and repeat all
   relevant layers until another pass yields no actionable defects.

## Finding and Fix Policy

Each finding is evaluated for reproducibility, impact, and an appropriate
verification method. Confirmed defects are fixed when the repository contains
the responsible implementation and the change can be made without inventing
unknown business policy. Meaningful fixes receive regression tests whenever a
stable automated assertion is practical.

The review prioritizes:

1. Security, privacy, tenant isolation, authentication, and data integrity.
2. Crashes, broken workflows, incorrect business behavior, and integration
   reliability.
3. Accessibility, confusing or missing UI states, and mobile usability.
4. Performance, SEO, operational resilience, and maintainability risks that
   plausibly lead to defects.

Pure preference changes, risky schema or product decisions without evidence,
and issues owned entirely by unavailable external systems are documented rather
than guessed at.

## Production Safety

Production testing may include authenticated and state-changing workflows when
valid credentials and designated test data exist. It must not expose PHI,
unexpectedly contact real patients, create unrecoverable clinical or financial
records, or incur uncontrolled payment, telecom, messaging, or vendor charges.
Test modes, test tenants, reversible records, and synthetic recipient data are
used wherever supported. A workflow that cannot be exercised within these
boundaries is verified locally and recorded as externally constrained.

Secrets remain in environment variables and are never printed into reports,
committed, or copied into test fixtures.

## Verification

Verification is proportional to each change and culminates in the repository's
standard completion commands:

- `pnpm typecheck`
- `pnpm lint:resupply`
- `pnpm test`
- `pnpm build`

Additional checks include formatting, architecture and migration guards,
focused package tests, local browser and accessibility tests, production health
and routing probes, and before/after website audit results where tooling permits.
Perceptible web UI changes are inspected at desktop and mobile widths and
captured in a screenshot.

## Completion Criteria

The work is complete when:

- All confirmed actionable findings discovered by the audit are fixed.
- Meaningful fixes have focused regression coverage where practical.
- The standard typecheck, lint, test, and build commands pass.
- Relevant local end-to-end and accessibility journeys pass.
- Production probes and the final crawl show no remaining repository-fixable
  errors or warnings.
- A final targeted code review finds no additional actionable defect.
- Any remaining limitation is specifically tied to unavailable credentials,
  external vendor state, environment capability, or a business decision that
  cannot safely be inferred.

The final pull request summarizes changes, tests, production checks, and any
explicit external limitations.
