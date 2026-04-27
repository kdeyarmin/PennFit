# Penn Fit — CPAP Mask Fitter

## Overview

Penn Fit is a web application designed for Penn Home Medical Supply, LLC, to guide patients in selecting the best-fit CPAP mask. The application provides a privacy-first facial measurement process and a clinical questionnaire to recommend suitable CPAP masks from Penn's catalog.

**Key Capabilities:**

*   **Privacy-First Facial Measurement:** Utilizes on-device processing of facial images to extract numeric measurements without transmitting or storing sensitive image data.
*   **Clinical Questionnaire:** Gathers patient-specific information to refine mask recommendations.
*   **Personalized Mask Recommendations:** Provides a ranked list of top masks with detailed justifications, considering both facial fit and clinical needs.
*   **Order Placement:** Facilitates order submission to Penn Home Medical Supply through a secure and stateless API.
*   **Brand Alignment:** Adheres to Penn's branding with a distinct visual design system.
*   **Tutorial:** Includes an animated tutorial to guide users through the fitting process.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log order request bodies in the application logger (treat every log line as world-readable).

**Database / PHI policy (April 2026 update — overrides earlier "no PHI persistence" rule):**
Order rows ARE persisted to PostgreSQL so Penn staff can ship, bill insurance, and verify prescriptions through an internal admin dashboard at `/admin/*`. The patient-facing consent and `/privacy` pages disclose this storage explicitly. Camera images and video streams remain on-device only — never uploaded.

## System Architecture

The Penn Fit application adopts a privacy-first, stateless architecture with a focus on on-device processing for sensitive patient data.

### Privacy-First Design
All facial image processing occurs exclusively on the user's device using MediaPipe Face Mesh. Camera images and video streams never leave the browser. Only numeric measurements (in millimeters) are transmitted to the backend. The recommendation engine (`POST /api/recommend`) is stateless and discards measurements after responding.

### Order Persistence + Admin Dashboard (HIPAA-aware)
`POST /api/orders` writes a Drizzle row to the `orders` table BEFORE attempting SendGrid delivery, so a failed email leaves a recoverable row marked `email_status='failed'`. The patient consent checkbox at the order step and the `/privacy` page (Section 03 "Order Data Storage") disclose this storage explicitly. A honeypot field (`website`) short-circuits with fake success and never touches the DB.

An internal admin dashboard lives inside the same `cpap-fitter` artifact at `/admin/*`, gated by:
1. Clerk session (provisioned via `setupClerkWhitelabelAuth()`).
2. `requireAdmin` middleware that requires a verified primary email AND membership in the `PENN_ADMIN_EMAILS` comma-separated allowlist. In production the middleware fails closed (503) if `PENN_ADMIN_EMAILS` is unset; in development any signed-in user is treated as admin for local-loop convenience.

Every PHI-touching admin read writes a row to `admin_audit_log`: list-orders (any filter), search-orders, and view-order-detail.

Anonymous funnel events (`home_view`, `consent_given`, `capture_started`, …) are POSTed to `/api/usage-events` (rate-limited 30/min, no auth, no IP/UA stored — only a per-tab session id).

### Tech additions
- `@workspace/db` (Drizzle + node-postgres) with three new tables: `orders`, `usage_events`, `admin_audit_log`.
- `@clerk/express` (server) + `@clerk/react` + `@clerk/themes` (frontend) wrapped in a Penn-branded `<ClerkProvider>`.
- Content-Security-Policy in `index.html` widened to allow `*.clerk.accounts.dev`, `*.clerk.com`, and `challenges.cloudflare.com` (Clerk bot protection).

### Technical Stack
*   **Monorepo Tool:** pnpm workspaces
*   **Node.js Version:** 24
*   **Package Manager:** pnpm
*   **TypeScript Version:** 5.9
*   **API Framework:** Express 5
*   **Validation:** Zod (generated from OpenAPI spec)
*   **API Codegen:** Orval (from OpenAPI spec)
*   **On-device AI:** MediaPipe Face Mesh (`@mediapipe/tasks-vision`) for 478 facial landmarks
*   **Frontend:** React, Vite, Tailwind CSS, Wouter routing

### Application Flow
The user journey includes distinct stages:
1.  **Home:** Landing page.
2.  **Consent:** BIPA-aware privacy disclosures.
3.  **Capture:** Live camera feed with face oval guide and 3-second steady-shot countdown. Calibration is iris-based (11.7 mm average iris diameter).
4.  **Measure:** On-device MediaPipe processing extracts numeric measurements, and the captured image is immediately discarded.
5.  **Questionnaire:** 11 clinical questions for personalized recommendations.
6.  **Results:** Displays top 3 mask recommendations with confidence scores.
7.  **Order:** Patient/contact/shipping/insurance/prescription intake form.
8.  **Order Success:** Confirmation page with an order reference.
9.  **Masks:** Filterable mask catalog browser.
10. **Privacy:** Privacy policy stub.

### Recommendation Scoring
The recommendation engine uses a combined score:
*   **Combined score** = (typeScore × 0.60 + fitScore × 0.40) × contraMultiplier × pressureMultiplier
*   **typeScore:** Driven by questionnaire answers.
*   **fitScore:** Based on physical match between facial measurements and mask size ranges.
*   **contraMultiplier:** Reduces score for contraindications (e.g., heavy beard for full-face).
*   **pressureMultiplier:** Reduces score for high-pressure patients with unsuitable masks.
*   **Top-3 diversification:** Ensures a variety of mask types in the top recommendations.

### Visual Design System
The application features a high-end, professional visual language using Penn's navy and gold brand palette.
*   **No Dark Mode:** Intentional design decision for a light-mode-only interface.
*   **Brand Tokens:** Custom CSS properties for Penn navy, gold, and other brand colors.
*   **Reusable Utility Classes:** Tailwind CSS classes for consistent styling of cards, icons, buttons, and form elements.
*   **Eyebrow Pattern:** Consistent page header design with small caps text and gradient gold accents.
*   **Page Background:** Layered "ambient atmosphere" — eight stacked radial blooms (cool plinth, gold sun + sunrise top-right, navy bloom top-left, mid-right depth, navy bottom plinth, gold whisper bottom-left) plus a diagonal sheen highlight, a viewport-fixed navy dot grid masked into a soft center bloom, and a low-opacity SVG `feTurbulence` grain. Background is `fixed` so it anchors as you scroll. The penn-fit-tutorial standalone page mirrors the same recipe (with rgba literals instead of HSL vars) so the two artifacts feel like one product.
*   **Scroll Restoration:** `window.scrollTo(0, 0)` on route changes for enhanced user experience.

### Tutorial Video
A short, animated tutorial (`/penn-fit-tutorial/`) guides users. The standalone landing page mirrors the cpap-fitter's "ambient atmosphere" page background (see the design-system note above) so the two artifacts feel like one product. It's built with framer-motion + lucide-react, brand-themed, and features dual-mode rendering: embedded (inside the main app) or standalone (full landing experience with navigation and a written walkthrough). Real app screenshots are embedded for visual accuracy. Total runtime is ~58 seconds — each scene is timed so all body copy is revealed by ~70% of its duration, leaving 4-6 seconds of "everything visible" hold time at the end for re-reading before the next scene transitions in. The video container uses a portrait aspect ratio (`aspect-[3/5]`) on mobile and 16:9 (`sm:aspect-video`) from tablet up — required because Scenes 2 and 4 stack their phone-mockup + text vertically on mobile, which doesn't fit a 16:9 letterbox. Scene 2 reuses the home-page screenshot for Step 1 (the camera-capture page can't be screenshotted in headless because no camera is available). Mobile-only content density is reduced in Scenes 2 and 4 (smaller phone, hidden long-form paragraphs/taglines, condensed chip rows) so all scene content fits inside the container without clipping.

## CPAP Resupply Automation (separate product, same monorepo) — Phase 1

A second product lives alongside Penn Fit in this repo: the **CPAP Resupply Automation** system. It is a different product (operator-facing console + automated multi-channel patient outreach) with different branding and a separate Postgres schema (`resupply.*`). Phase 0 shipped scaffolding; Phase 1 added the database schema and pgcrypto-backed PHI encryption — no operator-facing business logic yet.

### Layout
*   `artifacts/resupply-api/` — Express + Zod + Pino HTTP API mounted at `/resupply-api/*`. Exposes `GET /resupply-api/healthz` (liveness, never touches dependencies) and `GET /resupply-api/readyz` (readiness — probes Postgres + the pg-boss queue, returns 503 with structured per-dependency error categories on failure, never echoes raw driver text). The deploy gate in `.replit-artifact/artifact.toml` points at `/readyz` so production is only marked deployed once dependencies are reachable. Readiness logic lives in `src/lib/readiness.ts` with a closed allowlist of failure categories that mirrors the `CheckError` enum in `lib/resupply-api-spec/openapi.yaml`.
*   `artifacts/resupply-worker/` — pg-boss background worker (no HTTP, no preview). Connects to `DATABASE_URL`, logs `resupply-worker ready`, stays alive. Workflow name: `Resupply Worker`.
*   `artifacts/resupply-dashboard/` — React + Vite operator console at `/resupply/`. Default scaffold; real pages land in Phase 4+.
*   `lib/resupply-{contracts,domain,db,audit,telecom,ai,testing}` — seven composite TypeScript libs with the dependency rules below. `resupply-db` now ships the full Phase 1 schema; the others remain empty until later phases.

### Postgres pool
There is exactly **one** Postgres pool per resupply process. It is owned by `@workspace/resupply-db` (`lib/resupply-db/src/pool.ts`) and exposed as `getDbPool()`. Every resupply package (API readiness, future query helpers, etc.) imports that helper. The `resupply-check` architecture rule (Rule 7) forbids `new Pool(` anywhere in `artifacts/resupply-*/src` or any other resupply lib so a future contributor can't silently re-introduce a second pool. The worker's pg-boss connection is intentionally separate (ADR 002).

### Database (Phase 1)
*   All resupply tables live under the Postgres `resupply` schema (created by `pgSchema('resupply')` in `lib/resupply-db/src/schema/_schema.ts`). Tables: `patients`, `prescriptions`, `episodes`, `conversations`, `messages`, `fulfillments`, `audit_log`. Apply with `pnpm --filter @workspace/resupply-db push` (interactive) or `... push:force` (CI).
*   Drizzle config (`lib/resupply-db/drizzle.config.ts`) sets `schemaFilter: ["resupply"]` so drizzle-kit ignores Penn Fit's `public.*` tables.
*   PHI columns are stored as `bytea` and encrypted with pgcrypto. Helpers in `lib/resupply-db/src/encryption.ts`: `encryptedText(name)` / `encryptedJson(name)` declare the column; the SQL helpers `encrypt()` / `encryptJson()` go in `.values({...})` payloads, and `decrypt()` / `decryptJson()` go in select projections (`db.select({ dob: decrypt(patients.dateOfBirth) })`). The column types intentionally throw on direct read/write so plaintext can never bypass the helpers.
*   `RESUPPLY_DATA_KEY` (32-byte hex) is required at every encrypt/decrypt site. Set in development; for production, see ADR 007's KMS migration trigger.
*   pgcrypto preflight: `lib/resupply-db/scripts/preflight.mjs` runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` and verifies it. It runs automatically from `scripts/post-merge.sh` BEFORE `db push`, so a fresh environment can never end up with the schema present but the extension missing. The API and worker also call `assertPgcryptoEnabled(getDbPool())` at startup (from `@workspace/resupply-db`) and refuse to listen / start pg-boss with a clear `PgcryptoNotInstalledError` if it is missing — this turns a confusing "function pgp_sym_encrypt does not exist" runtime error into a fail-fast boot error.
*   Round-trip is covered by `lib/resupply-db/src/encryption.test.ts` (3 vitest cases including a missing-key safety test); the suite skips when `DATABASE_URL` or `RESUPPLY_DATA_KEY` is unset.

### Dependency rules
Enforced by `scripts/check-resupply-architecture.sh` and the `resupply-check` validation step. The full ruleset and rationale live in `docs/resupply/ARCHITECTURE.md`. The short version: `contracts` may only import zod; `domain` is pure (no I/O); `db`/`telecom`/`ai` are isolated layers that do not import each other; `testing` is devDeps only and never reaches production code; the resupply tree may not import Penn Fit's `lib/db`, `lib/api-zod`, or `lib/api-client-react`.

### Architectural decisions (deviations from original AWS plan)
Twelve ADRs in `docs/resupply/adr/` (000–007 and 009–012) document why the Replit substitutes were chosen. Highlights:
*   Express + Zod (not NestJS), Drizzle (not Prisma), pg-boss (not Temporal), pgcrypto + `RESUPPLY_DATA_KEY` env var (not AWS KMS — migration trigger documented in ADR 007), Clerk (not Cognito), Twilio + SendGrid for telecom, Anthropic Claude for AI conversation, manual CSV exchange for the Pacware integration, no Docker / no Redis / no Mailhog, React + Vite (not Next.js), no Turborepo / no Husky.
*   Each substitute lists its migration trigger so Phase 9 production hardening is a checklist, not a vibe.

### Validation
*   `resupply-check` validation step runs the architecture check + `pnpm -r --filter '@workspace/resupply-*' run typecheck` + vitest.
*   A local pre-commit hook (`scripts/git-hooks/pre-commit`, installed by `scripts/install-hooks.sh`) runs the codegen drift + architecture checks before the commit lands, so developers don't wait for server-side validation to discover a missed `pnpm run codegen`. The hook is auto-installed by `scripts/post-merge.sh`, runs only when staged files touch `lib/api-spec`, `lib/resupply-api-spec`, the generated client trees, `lib/resupply-*`, or `artifacts/resupply-*`, and is bypassable with `SKIP_HOOKS=1` or `git commit --no-verify`.
*   The hook executes against an **isolated snapshot of the staged index**, not the live working tree. Unstaged edits and untracked files are captured to a patch + tar archive, removed for the duration of the checks, then restored. This means the checks see exactly what the commit will introduce — unstaged edits can't mask drift the commit actually adds, and they can't trigger drift the commit doesn't add. The snapshot logic lives in `scripts/git-hooks/lib-staged-snapshot.sh` and is verified by `scripts/git-hooks/lib-staged-snapshot.test`. The snapshot is skipped during in-progress merges/rebases/cherry-picks (with a warning) since mutating the working tree in those states is unsafe.

## External Dependencies

*   **SendGrid:** For sending order fulfillment emails from `POST /api/orders`.
*   **MediaPipe Face Mesh:** Google's machine learning solution for on-device facial landmark detection. WASM runtime and the `face_landmarker.task` model are **self-hosted** under `artifacts/cpap-fitter/public/mediapipe/` (populated by `scripts/setup-mediapipe.mjs` via predev/prebuild hooks; the directory is gitignored). No external CDN is contacted at runtime, which lets the app's CSP stay strict.
*   **AWS:** Deployment target for HIPAA-compliant infrastructure with a Business Associate Agreement (BAA).

## Recent Hardening (April 2026 deep-review pass)

A full severity-ranked review was implemented end-to-end. Key items future contributors should be aware of:

### Backend (`artifacts/api-server`)
*   `app.ts` enables `trust proxy` (required for accurate client IPs behind the Replit / AWS proxy), reads its CORS allowlist from `PENN_ALLOWED_ORIGINS` (comma-separated), and caps JSON bodies at 100 kb.
*   `routes/orders.ts` applies `express-rate-limit` keyed via `ipKeyGenerator` (do **not** swap to raw `req.ip` — it breaks IPv6 normalization), and short-circuits with a fake-success response if the honeypot field `website` is non-empty. Honeypot hits are intentionally indistinguishable from real success on the wire.

### Frontend routing (`artifacts/cpap-fitter/src/App.tsx`)
*   Protected routes are implemented as **inline `Guarded*` function components rendered via standard `<Route component={GuardedX}>`**. Wouter's `<Switch>` only inspects the `path` prop on its direct `<Route>` children, so a generic `<ProtectedRoute>` wrapper component falls through to `NotFound`. Keep guards inline.
*   Each guard reads from the in-memory fitter store and returns `<Redirect>` when the precondition fails — preventing flash-of-protected-content. Per-page `useEffect`+`setLocation`+`return null` guards have been removed.

### Form accessibility (`artifacts/cpap-fitter/src/pages/order.tsx`)
*   The `Field` helper generates an id with `useId()` and clones its child input to bind `htmlFor`. For shadcn `Select` triggers (which already render their own label association), pass `skipHtmlFor` to avoid double-binding.
*   The honeypot `website` input is registered in the zod schema, rendered offscreen with `aria-hidden`, `tabindex={-1}`, and `autocomplete="off"`; the submit handler short-circuits to a fake success when filled.

### Type safety
*   `lib/api-client-react/src/index.ts` now re-exports `ApiError` and `ErrorType` so consumers can type errors as `ApiError<{error?: string; details?: string[]}>` instead of `as any`.
*   `order.tsx`'s `consentToContact` uses `z.boolean().refine()` so the form no longer needs the `false as unknown as true` cast.