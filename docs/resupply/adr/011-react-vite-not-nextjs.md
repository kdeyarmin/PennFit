# ADR 011 — React + Vite (not Next.js) for the admin dashboard

## Context

The original plan called for Next.js 14 (app router) for the admin
dashboard. The existing scaffold (and the `artifacts/cpap-fitter` PennPaps
fitter) is React + Vite + Tailwind + shadcn/ui, so the dashboard inherits
that pattern.

Adding Next.js would mean:

- A second framework in the monorepo with a different routing model and a
  different production-build story.
- A different relationship to the OpenAPI codegen pipeline (Next.js apps
  can use the generated React Query hooks fine, but the SSR / RSC parts
  are wasted in a static admin tool).
- A different reverse-proxy story (Next.js wants to own the server; the
  Railway edge proxy already routes by path).

## Decision

Use React + Vite for `artifacts/resupply-dashboard` at `previewPath: "/resupply/"`.

- Routing: `wouter` (matches the PennPaps fitter).
- Data fetching: TanStack Query via the auto-generated hooks from
  `lib/resupply-api-client-react` (created in Phase 4 alongside the OpenAPI
  spec for the resupply api).
- UI: Tailwind + shadcn/ui (matches the PennPaps fitter).
- Auth: in-house cookie sessions via `lib/resupply-auth-react` (see ADR 014).

The dashboard is purely an internal admin tool — there is no SEO need,
no public marketing pages, no need for SSR. Static React fits perfectly.

## Consequences

- Same frontend stack across both products. Admins get a familiar UX,
  developers get one mental model.
- We give up Next.js features we would not have used anyway (RSC, ISR,
  built-in API routes). The api lives in `artifacts/resupply-api`
  separately, which is where it belongs.

## Alternatives Considered

- **Next.js** — rejected as above.
- **Remix** — same critique as Next.js.
- **Plain HTML + htmx** — admins want filters, sortable tables, and
  modal flows; SPAs handle this better.
