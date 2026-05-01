# ADR 001 — Express + Zod, not NestJS

## Context

The original plan specified NestJS for the api and worker apps. NestJS brings
opinionated DI, decorators, modules, guards, and interceptors that scale well
in large multi-team backends.

This monorepo already runs an Express + Zod api-server (the PennPaps fitter api).
Adding NestJS as a second framework would mean two routing models, two
testing styles, two error-handling conventions, and two ways to mount
middleware — for a single-team product.

## Decision

Use Express 5 + Zod for `artifacts/resupply-api` and `artifacts/resupply-worker`.

- Routing: `express.Router()` per domain area, matching the PennPaps fitter pattern.
- Validation: Zod schemas generated from `lib/api-spec/openapi.yaml` (when
  the api spec is added in Phase 1+).
- Logging: Pino + pino-http, same as the PennPaps fitter.
- Auth: in-house cookie sessions (`lib/resupply-auth`); see ADR 014.
- Testing: Vitest + supertest.

The existing `artifacts/api-server` shows the canonical pattern.

## Consequences

- New backend developers only need to learn one framework across both
  products.
- We give up NestJS's built-in DI container. Most of what DI buys is
  testability, which Vitest's module mocking handles fine. If we hit a real
  growth pain (e.g. needing per-request scoped services), revisit.
- We give up `@nestjs/swagger` auto-generation. We use Orval against the
  hand-maintained OpenAPI spec instead — same workflow as the PennPaps fitter.

## Alternatives Considered

- **NestJS** — rejected as above. DI overhead unwarranted for a 1-team
  product.
- **Fastify** — rejected to avoid yet a third framework in the monorepo.
- **Hono / tRPC** — rejected; Hono is fine but Express is what is already
  here. tRPC removes the OpenAPI contract, which we want for cross-language
  clients (e.g. a future mobile app).
