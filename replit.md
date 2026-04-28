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
*   **Audit-log helper (`@workspace/resupply-audit`).** A dedicated package owns every write to `resupply.audit_log`. `logAudit({ action, operatorEmail?, operatorClerkId?, targetTable?, targetId?, metadata?, ip?, userAgent? })` runs a raw INSERT via `getDbPool()` so the path is independent of the Drizzle schema graph. Metadata flows through `sanitizeMetadata` first: it rejects PHI-shaped keys at any depth, caps payload at 8 KiB, caps depth at 6, refuses non-plain objects (class instances, Maps, Sets, Buffers), refuses objects with a `toJSON` method (closes the "key check passes, then `JSON.stringify` rewrites the row" bypass), and refuses symbol-keyed properties. Key matching tokenizes with NFKC + camelCase / snake_case / kebab-case / digit splits so `patientEmail`, `email_address`, and the unicode-confusable `ｅmail` all hit the same denylist entry; generic terms like `state`/`name`/`notes` only fire on whole-key match so `previousState` and `displayName` pass. The helper throws on any violation — audit-row PHI is HIPAA-reportable, so a bug must surface as a 500 not a silent strip.
*   **Sanitize/serialize TOCTOU defence.** `sanitizeMetadata` walks the input ONCE, captures `Object.entries` results into local snapshots, and builds a deep plain-data clone. The clone (not the input) is what `logAudit` serializes to JSON for the INSERT. This closes a Proxy/getter TOCTOU where the sanitizer's first walk and `JSON.stringify`'s second walk could see different shapes — the clone has no live proxies/accessors/`toJSON` to re-evaluate. Tests cover Proxy values that flip on second access, accessor counters that prove single-evaluation, and Proxy `length` that grows on subsequent reads (snapshotted).
*   **Architecture Rule 8 (single audit writer).** `scripts/check-resupply-architecture.sh` bans `resupply.audit_log` writers anywhere outside `lib/resupply-audit/src/`. Runs in multi-line mode (`rg -U`) so a contributor can't slip past line-oriented patterns by reformatting across newlines. Three patterns: (1) `.insert(<ident>?.audit*)` catches bare and namespaced Drizzle inserts including pretty-printed multi-line forms; (2) `import { ... auditLog ... } from "@workspace/resupply-db"` bans ANY import of the `auditLog` schema symbol — bare, aliased (`auditLog as al`), or in a multi-line braced clause — which also kills the indirect two-step alias bypass `import { auditLog }; const al = auditLog; db.insert(al)` because the symbol simply isn't in scope without the import; (3) `(?i)INSERT [^;``"']* audit_log` catches raw SQL including multi-line pretty-printed template literals and `${schema}.audit_log` interpolations, with the gap matcher excluding string-literal boundaries (backtick / `"` / `'`) so it can't bridge from a code comment containing the word "INSERT" into an unrelated quoted DELETE on a later line. SELECT/DELETE remain allowed (queries + test cleanup). 14 self-tests cover every bypass class — bare import, aliased import, indirect alias, namespaced insert, multi-line braced import, multi-line `.insert(...)`, multi-line raw INSERT, template-literal interpolation, plus the no-false-positive cases (`.insert(patients)`, comment mentioning `audit_log`, comment containing the word "INSERT" near a legal `DELETE FROM audit_log`).
*   **Dashboard test surface.** `artifacts/resupply-dashboard/vitest.config.ts` runs jsdom + `@vitejs/plugin-react` (standalone — `vite.config.ts` refuses to load without `PORT`/`BASE_PATH`, which are dev-server concerns). `not-authorized.test.tsx` exercises all three reason branches (`not-authorized`, `not-configured`, `transient`), the `contactEmail` prop override, the sign-out wiring, and the Try-again click — six cases total. The Try-again case asserts the click does not throw rather than spying on `window.location.reload`, because jsdom makes `location` non-configurable; the architect flagged this as a low-severity follow-up.

#### Validation
`resupply-check` is the single command that gates every resupply change. It runs the architecture self-test (cross-package import rules and the codegen drift check), the staged-snapshot self-test, lint, typecheck, and tests for every `@workspace/resupply-*` package — including the readiness integration test described above.

#### Voice (outbound resupply calls)
Outbound automated phone calls run inside `artifacts/resupply-api` itself — see ADR 008 for the full design. Twilio Voice handles the telephony (Media Streams, g711 µ-law @ 8 kHz); OpenAI's Realtime API (`gpt-realtime`, voice `marin`) drives the conversation. Both legs use g711 µ-law so audio is forwarded byte-for-byte with no transcoding. The bridge is a `WebSocketServer({ noServer: true })` attached to an explicit `http.createServer(app)`; the upgrade handler routes only `/resupply-api/voice/stream` and rejects everything else by destroying the socket.
*   **Endpoints.** `POST /voice/place-call` (operator-protected) opens a `conversations` row, registers a 5-min in-memory pending session keyed on `conversationId`, and asks Twilio to dial. `POST /voice/twiml-connect` and `POST /voice/status-callback` are Twilio-only webhooks gated by HMAC signature (`requireTwilioSignature` from `@workspace/resupply-telecom`); `twiml-connect` is intentionally NOT in `lib/resupply-api-spec/openapi.yaml` because Twilio is its only legitimate caller. The WS handshake claims the pending session exactly once — a second claim returns null and the upgrade is rejected.
*   **Patient-context binding.** The model is never given a patient identifier. The dispatcher is constructed bound to `{ patientId, conversationId, episodeId }` from the claimed pending session, so every tool call operates on the bound patient regardless of model arguments. `verify_patient_identity` enforces a hard 3-attempt cap with constant-time DOB compare (`Buffer + timingSafeEqual`). The dispatcher has a two-tier identity gate: pre-lockout it exempts only `verify_patient_identity`, `request_human_handoff`, and `end_call`; once `verifyAttempts >= 3` AND not yet verified, the lockout layer above the regular gate refuses *all* tools except `request_human_handoff` and `end_call` — including further `verify_patient_identity` calls — so a doomed caller cannot loop on DOB attempts. The lockout stub returns `attempts_remaining: 0` to give the model a stable exhausted-state signal. All seven tools (verify identity, lookup inventory, get/update address, place order, handoff, end call) are zod-typed in `lib/resupply-ai/src/tools.ts` and the lockout semantics are pinned by `tools-impl.test.ts` (countdown, 4th-call refusal without DB hit, side-effect blockade, escape-tool allowlist, repeat-stability).
*   **Persistence + audit.** Transcript turns are coalesced per item id and persisted as one `resupply.messages` row per turn, body encrypted with the existing `encrypt()` helper. **Audio is never stored.** Tool invocations emit `voice.tool.invoked` audit rows with `sanitizeMetadata`-cleaned arg shapes; lifecycle emits `voice.call.placed` (from `place-call`) and `voice.call.completed` (from both the WS finaliser AND `status-callback`; idempotent `closed` makes double-firing safe). Twilio body fields `From`/`To` are deliberately ignored on the status callback because they carry PHI.
*   **Architecture rules 9 + 10.** `lib/resupply-ai/src/` may not import `@workspace/resupply-db`, `pg`, or `twilio` (the AI lib is a pure OpenAI Realtime adapter; `ws` is the explicit transport carve-out). `lib/resupply-telecom/src/` may not import `@workspace/resupply-db`, `pg`, `openai`, or `@anthropic-ai/sdk`. Patterns are quote-anchored (`@workspace/resupply-db['"]`) so a code comment mentioning the package name doesn't trip the gate. Both rules are covered by negative self-tests in `scripts/check-resupply-architecture.sh.test`.
*   **Feature-flagged on env presence.** Voice routes return a 503 with a stable error code (`voice_not_configured` or `voice_outbound_not_configured`) when any of `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `RESUPPLY_VOICE_PUBLIC_BASE_URL` (or `TWILIO_PHONE_NUMBER` for outbound only) is missing. The 503 is documented in the OpenAPI spec — it's published behaviour, not a bug. The Twilio Replit integration was offered and dismissed; voice credentials are loaded from secrets directly (re-propose `connector:ccfg_twilio_01K69QJTED9YTJFE2SJ7E4SY08` if you'd rather use the integration).
*   **Single-instance assumption.** The pending-session map is in-process. A future multi-replica deploy needs a shared session store (Postgres-backed) before voice can scale out — captured in ADR 008 consequences.
*   **Inbound deferred.** Inbound TwiML needs to map a caller's E.164 number back to a `patients` row, but the phone column is encrypted random-IV (`encryptedText`), so equality lookup is impossible without a separate lookup table or a deterministic-encrypted column. Schema change + threat-model revision required; tracked as a backlog item.

## External Dependencies

*   **SendGrid:** Used for sending order fulfillment emails from the backend.
*   **MediaPipe Face Mesh:** Google's on-device facial landmark detection solution. The WASM runtime and model are self-hosted to maintain a strict Content Security Policy.
*   **AWS:** Deployment target, providing HIPAA-compliant infrastructure with a Business Associate Agreement (BAA).