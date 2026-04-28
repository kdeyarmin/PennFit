# Penn Fit — CPAP Mask Fitter

## Overview

Penn Fit is a web application designed for Penn Home Medical Supply, LLC, to assist patients in selecting the most suitable CPAP mask. The application prioritizes user privacy through on-device facial measurements and combines this with a clinical questionnaire to provide personalized, justified mask recommendations from Penn's product catalog. It also facilitates order placement and adheres to Penn's brand guidelines, including an animated tutorial for user guidance.

**Key Capabilities:**

*   **Privacy-First Facial Measurement:** On-device processing of facial images for measurements, without transmitting or storing sensitive image data.
*   **Clinical Questionnaire:** Gathers patient data for refined mask recommendations.
*   **Personalized Mask Recommendations:** Delivers a ranked list of masks with justifications based on facial fit and clinical needs.
*   **Order Placement:** Securely submits orders to Penn Home Medical Supply via a stateless API.
*   **Brand Alignment:** Incorporates Penn's distinct visual design system.
*   **Tutorial:** Guides users through the fitting process with an animated video.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

## System Architecture

The Penn Fit application employs a privacy-first, stateless architecture, emphasizing on-device processing for sensitive data and secure handling of persistent information.

### Privacy and Data Handling

Facial image processing is entirely on-device using MediaPipe Face Mesh; only numeric measurements are sent to the backend. The recommendation engine is stateless. Order data, including PHI, is persisted in PostgreSQL to facilitate shipping, billing, and prescription verification via an internal admin dashboard. Patient consent and privacy policies explicitly disclose this storage. Camera images and video streams are never uploaded or stored. Anonymous usage events are collected without storing identifiable information.

### Admin Dashboard

An internal admin dashboard (`/admin/*`) within the same artifact allows Penn staff to manage orders. Access is restricted via Clerk authentication and an email allowlist (`PENN_ADMIN_EMAILS`). All PHI-touching admin reads are logged in an `admin_audit_log` table.

### Technical Stack

*   **Monorepo Tool:** pnpm workspaces
*   **Node.js:** v24
*   **Package Manager:** pnpm
*   **TypeScript:** v5.9
*   **API Framework:** Express 5
*   **Validation:** Zod (from OpenAPI spec)
*   **API Codegen:** Orval
*   **On-device AI:** MediaPipe Face Mesh (`@mediapipe/tasks-vision`)
*   **Frontend:** React, Vite, Tailwind CSS, Wouter
*   **Database:** Drizzle ORM + node-postgres (`@workspace/db`) for `orders`, `usage_events`, `admin_audit_log`.
*   **Authentication:** Clerk (`@clerk/express`, `@clerk/react`, `@clerk/themes`) for admin authentication.

### Application Flow

The user journey is structured into several stages: Home, Consent, Capture (facial scan), Measure (on-device processing), Questionnaire, Results (mask recommendations), Order (intake form), Order Success, Masks (catalog browser), and Privacy policy.

### Recommendation Scoring

The recommendation engine calculates a combined score using:
`Combined score = (typeScore × 0.60 + fitScore × 0.40) × contraMultiplier × pressureMultiplier`
`typeScore` is derived from questionnaire answers, `fitScore` from facial measurements, `contraMultiplier` reduces scores for contraindications, and `pressureMultiplier` adjusts for high-pressure patients. Diversification ensures variety in top recommendations.

### Visual Design System

The application features a high-end, professional aesthetic using Penn's navy and gold brand palette.
*   **Design Choices:** Light-mode only, custom CSS brand tokens, reusable Tailwind CSS utility classes, consistent "eyebrow" page header pattern, and a layered "ambient atmosphere" background with radial blooms and a dot grid.
*   **Scroll Restoration:** `window.scrollTo(0, 0)` on route changes.

### Tutorial Video

A short, animated tutorial (`/penn-fit-tutorial/`) is provided, built with `framer-motion` and `lucide-react`, matching the main app's branding. It supports both embedded and standalone viewing, with responsive aspect ratios for mobile and tablet/desktop.

### CPAP Resupply Automation System

A separate product, the CPAP Resupply Automation system, coexists in the monorepo. This system, for operators, uses a distinct Postgres schema (`resupply.*`) and focuses on automated patient outreach.

*   **Components:** `artifacts/resupply-api/` (Express API on `:8083`, base path `/resupply-api`), `artifacts/resupply-worker/` (pg-boss background worker), `artifacts/resupply-dashboard/` (React operator console at `/resupply/`).
*   **Database:** Resupply tables (`patients`, `prescriptions`, `episodes`, `conversations`, `messages`, `fulfillments`, `audit_log`) are under the `resupply` schema. PHI columns are encrypted using `pgcrypto` with `RESUPPLY_DATA_KEY`. Startup checks ensure `pgcrypto` is enabled.
*   **Architecture Decisions (Resupply):** Utilizes Express + Zod, Drizzle, pg-boss, `pgcrypto`, and Clerk. ADRs live in `docs/resupply/adr/`.

#### Versioned migrations (drizzle-kit)
The resupply schema is owned by `@workspace/resupply-db` and managed with **versioned migrations**, not push. The runner is `lib/resupply-db/scripts/migrate.mjs`, invoked with `pnpm --filter @workspace/resupply-db migrate`. Two safety properties matter:
*   **Migration application.** The runner delegates to drizzle-orm's `migrator` (`drizzle-orm/node-postgres/migrator`), which reads each `.sql` file in `lib/resupply-db/drizzle/`, splits on drizzle-kit's `--> statement-breakpoint` marker, and executes the statements on the supplied connection. Combined with drizzle's own `__drizzle_migrations` ledger this gives us idempotent, ordered migrations.
*   **Cross-process advisory lock.** Before invoking the migrator, the runner takes `pg_advisory_lock(7427398427542000001)` on a pinned `PoolClient` (`max: 1`, so the same physical connection used to release the lock) and releases it after commit (or on error, falling back to `pool.end()` to drop the socket if `pg_advisory_unlock` itself failed inside an aborted transaction). Two CI runners or a redeploy + a developer running `migrate` in parallel will serialise on the lock instead of racing each other into duplicate-create errors.
The post-merge script (`scripts/post-merge.sh`) runs `migrate` rather than `push:force` on every merge so production-shaped DDL is exercised in dev. Authoring new migrations: edit `lib/resupply-db/src/schema.ts`, then `pnpm --filter @workspace/resupply-db generate`, review the SQL, and check it in.

#### Readiness probe (`/readyz`)
`artifacts/resupply-api` exposes `/readyz`, a closed-allowlist probe used by the deployment health check. It runs two checks in parallel under a per-check timeout:
*   **`db`** — a `SELECT 1` round-trip on the resupply DB pool.
*   **`queue`** — `pg-boss` schema readiness, inferred from the existence of `pgboss_resupply.version`. The API process does not run `pg-boss` (the worker owns it — see `docs/resupply/adr/002-*`), so this is the only signal that the worker has finished bootstrapping the queue.

Failures are bucketed into a small fixed set of category strings (`timeout`, `connection_refused`, `host_not_found`, `database_starting_up`, `database_does_not_exist`, `schema_not_initialized`, `unavailable`) by `categorize()` in `artifacts/resupply-api/src/lib/readiness.ts`; raw driver text is sent through `logger.warn` but never returned in the HTTP body, because `pg`'s error messages happily echo `DATABASE_URL` fragments. Validated end-to-end by `artifacts/resupply-api/src/lib/readiness.integration.test.ts`, which boots the app against a real `DATABASE_URL`, creates a throwaway test DB, applies migrations via the shipped `migrate.mjs`, asserts the happy path returns 200, then induces failures (queue schema dropped; DB unroutable) and asserts the response body contains no `postgres://`, password, host, or full-`DATABASE_URL` text. The test skips cleanly when `DATABASE_URL`/`RESUPPLY_DATA_KEY` are unset, or when the connecting role lacks `CREATE DATABASE`, so it doesn't flap in environments without a suitably-privileged database. The pre-import permission probe sets `connectionTimeoutMillis: 5_000` so an unreachable URL can't hang vitest's discovery phase past the `describe.skipIf` gate.

#### Operator authentication (Clerk)
Both products share a single Clerk instance but use **disjoint allowlists** — `PENN_ADMIN_EMAILS` for Penn Fit and `RESUPPLY_OPERATOR_EMAILS` for Resupply — so rotating one product's staff list cannot accidentally grant access to the other.
*   **API.** `clerkMiddleware()` runs in front of `requireOperator` (`artifacts/resupply-api/src/middlewares/requireOperator.ts`). Allowlist mode requires a verified primary email AND an allowlist match; an unset env var **fails closed with 503 in production** and falls through to "any signed-in user" in `NODE_ENV=development` so dev loops and the e2e harness work without managing an env var. The smoke endpoint `GET /resupply-api/me` returns `{ clerkId, email }` and is the dashboard's auth probe.
*   **Dashboard.** `<ClerkProvider>` wraps the app in `main.tsx`; the console is gated by Clerk's `<Show when="signed-in">`. Bearer tokens are wired into the generated `@workspace/resupply-api-client` via `setAuthTokenGetter` registered at module load (so the very first `/me` request has a token without waiting for an effect commit) and re-registered on every session change in `useApiAuthBridge`.
*   **Friendly denial.** `artifacts/resupply-dashboard/src/pages/not-authorized.tsx` renders for `/me` errors: 503 → "Operator access isn't set up on this server yet"; everything else (incl. 403) → "This account isn't approved for the operator console" with the signed-in email and the operations contact. The status is read from `ApiError.status` (re-exported from the generated client) so the branch is type-safe rather than a generic `unknown` cast.

#### Operational hardening
A deep-review follow-up batch tightened several edges that were correct but fragile:
*   **Auth race / 4xx classification.** Dashboard query client (`main.tsx`) keeps the existing `staleTime`, disables `refetchOnWindowFocus`, and retries once on 401 (token refresh races) while still skipping retries for other 4xx — so a cold-load `/me` racing the Bearer wiring no longer produces a spurious "not authorized" screen.
*   **Clerk upstream failure ≠ auth failure.** When `clerkClient.users.getUser` throws, `requireOperator` returns **502 Bad Gateway** (not 401) and logs only `{ errName, clerkStatus }` — never the raw error. The dashboard's `NotAuthorizedPage` already maps non-503 5xx → the "transient, please retry" branch, so an operator with a valid session sees retry, not "sign out and try again." Test updated accordingly.
*   **Log redaction (defense in depth).** Both API and worker loggers (`logger.ts`) redact `err.message`, `err.detail`, `err.hint`, `err.where`, `err.hostname`, `err.address`, `err.stack`, and `err.cause.{message,stack}`. Stack is redacted because the message normally appears on line one of the stack — leaving stack open would re-leak DSN fragments / pg internals one field over. Call sites that need a stack must categorize (`{ errCategory, stackHash }`) instead of dumping `{ err }`.
*   **Readiness log shape.** `readiness.ts` warns log only the closed-allowlist `errCategory` (`db.*`, `queue.*`), never `err.reason` — pg drivers embed connection-string fragments in error messages, and every log line is treated as world-readable.
*   **Pino flush-on-exit.** Both API (`index.ts`) and worker (`index.ts`) await a 250ms flush window before `process.exit(1)` after `logger.fatal(...)`. Without it, pino's transport worker thread can drop the very line that explains why the process died.
*   **CORS credentials off.** API drops `credentials: true` — the dashboard authenticates with `Authorization: Bearer`, never cookies, so the CORS surface is now the simpler Bearer-only shape (no need for cookie-CSRF mitigations).
*   **Migration lock timeout.** `lib/resupply-db/scripts/migrate.mjs` sets `lock_timeout = '60s'` strictly around the `pg_advisory_lock` acquisition, then resets it to 0 before drizzle's migrate phase. A wedged holder fails the deploy gate audibly within 60s; legitimate long-running DDL is unbounded as before.
*   **Sign-out redirect parity.** `OperatorHeaderChip` passes `redirectUrl: ${basePath}/sign-in` to `signOut()`, matching `NotAuthorizedPage` so sign-out lands on the sign-in URL in one step.

#### Validation
`resupply-check` is the single command that gates every resupply change. It runs the architecture self-test (cross-package import rules and the codegen drift check), the staged-snapshot self-test, lint, typecheck, and tests for every `@workspace/resupply-*` package — including the readiness integration test described above.

## External Dependencies

*   **SendGrid:** Used for sending order fulfillment emails from the backend.
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection solution. The WASM runtime and model are self-hosted to maintain a strict Content Security Policy.
*   **AWS:** Deployment target, providing HIPAA-compliant infrastructure with a Business Associate Agreement (BAA).