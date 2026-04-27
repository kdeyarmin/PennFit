# ADR 010 — No Docker, no Redis, no Mailhog

## Context

The original plan included a `docker-compose.yml` to run Postgres, Redis,
Temporal dev server, and Mailhog locally. Replit does not run Docker.

## Decision

Drop all four locally-run containers from the dev environment.

- **Postgres** — provided natively by Replit via `DATABASE_URL`. No
  container needed.
- **Redis** — replaced by pg-boss (see ADR 002). Idempotency keys for
  Twilio sends are stored in a Postgres table with TTL semantics enforced
  by a daily cleanup job, instead of a Redis SETEX.
- **Temporal dev server** — replaced by pg-boss (see ADR 002).
- **Mailhog (email capture for dev)** — replaced by a `MockEmailAdapter`
  in `lib/resupply-telecom` that writes outbound emails to an in-memory
  log queryable by tests, plus the SendGrid sandbox API key for staging
  manual tests.

## Consequences

- Faster cold start: `pnpm install` + workflow restart is the entire dev
  loop. No `docker-compose up`.
- Tests do not require any external service beyond Postgres.
- Dev parity with prod is slightly weaker: production may use real Redis
  for things we are using Postgres for. Documented in ADR 002.

## Alternatives Considered

- **Run a Replit-managed Redis** — Replit does not currently offer one.
  External managed Redis (Upstash, Redis Cloud) adds a vendor and a BAA.
- **Keep Mailhog and run it via Nix** — possible but adds a service for a
  problem already solved by the mock adapter.
