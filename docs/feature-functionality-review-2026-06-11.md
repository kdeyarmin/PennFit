# Feature functionality review — 2026-06-11

End-to-end verification pass over every feature surface in the repo,
run from a clean checkout aligned to `origin/main` (commit `d45b27f9`).
Companion to the point-in-time hosting audit
([`railway-hosting-review-2026-05-29.md`](./railway-hosting-review-2026-05-29.md));
this one answers "does everything still work?" rather than "is the
hosting shaped right?".

**Verdict: all green.** Every static check, every unit suite, the
production build, the browser E2E suite, and a live boot-contract smoke
test of the built API passed with zero failures. No code changes were
required.

## What was run

| Check                    | Command                                      | Result                                                                                                                                                                       |
| ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript               | `pnpm typecheck`                             | ✅ clean (libs + both artifacts + scripts)                                                                                                                                   |
| ESLint (zero-warnings)   | `pnpm lint:resupply`                         | ✅ 0 errors, 0 warnings                                                                                                                                                      |
| Prettier                 | `pnpm format:check`                          | ✅ all files conform                                                                                                                                                         |
| Unit/integration tests   | `pnpm test`                                  | ✅ **10,325 passed, 0 failed** (3 skipped) across 24 packages; resupply-api alone: 492 test files / 5,157 tests                                                              |
| Architecture invariants  | `scripts/check-resupply-architecture.sh`     | ✅ pass (incl. no-direct-`pg`, no drizzle-orm in domain)                                                                                                                     |
| Admin route gate audit   | `scripts/check-admin-route-gates.sh`         | ✅ 324 admin mutations scanned, **0 ungated** (257 `requirePermission`, 67 coarse `requireAdmin` — informational)                                                            |
| Migration prefix guard   | `scripts/check-resupply-migration-prefix.sh` | ✅ pass (304 SQL files, contiguous through `0308`)                                                                                                                           |
| Production build         | `pnpm build`                                 | ✅ all libs, cpap-fitter (Vite), resupply-api (esbuild)                                                                                                                      |
| Browser E2E (Playwright) | `pnpm test:e2e` against the Vite dev server  | ✅ 7/7 — storefront smoke, results-page resilience (full fitter flow with mocked camera/MediaPipe), axe a11y sweep of `/`, `/shop`, `/consent`, `/contact`, `/admin/sign-in` |

## Live boot-contract smoke test

Booted the **built** `resupply-api` (`node dist/index.mjs`) with only the
five required env vars and deliberately unreachable DB/Supabase
credentials, to verify the degraded-mode contract from CLAUDE.md /
the deploy skill:

- `GET /resupply-api/healthz` → `200 {"status":"ok"}` (liveness has no
  dependencies). ✅
- `GET /resupply-api/readyz` → `503 {"checks":{"db":"failed","queue":"failed"}}`
  — reports, never gates. ✅
- **HTTP-before-worker decoupling:** pg-boss failed to start
  (ECONNREFUSED), logged `worker_start_failed`, scheduled background
  retries on a growing backoff (20s → 60s observed) — the listener
  stayed up throughout. No `process.exit`. ✅
- **SPA co-serving:** `/`, `/shop`, `/admin/sign-in` all `200` via the
  history fallback (correctly keyed on `Accept: text/html`); static
  assets and favicons served. ✅
- **R1 face-model safety net:** `mediapipe/models/face_landmarker.task`
  present in the built SPA and served (`206` on a range request) —
  the face-scan flow ships with its model. ✅
- **Public catalog without DB/Stripe:** `GET /api/masks` → `200`. ✅
- **AI offline posture:** `POST /api/chat` with no vendor keys →
  `200 { offline: true }` with the static phone/email fallback reply —
  no 5xx, exactly the documented degrade. ✅
- **Graceful shutdown:** SIGTERM → `shutdown: draining in-flight
requests` → `shutdown: complete` → clean exit. ✅

## Feature surfaces covered

Coverage came from the per-feature unit suites (every admin route file
ships a colocated `.test.ts`) plus the E2E flow, spanning: the fitter
flow (consent → capture → results), storefront shop/cart/checkout/
wishlist/orders, accounts + caregiver access, help & learn content
(sitemap-drift-tested), reminders & subscriptions, the full admin
console (analytics, billing hub incl. claims/ERA/denials/eligibility/
timely-filing/capped rentals/statements, conversations & routing,
campaigns, coaching, cases, inventory/backorders, locations, team &
permissions, PacWare import/export, integrations registry, security/
MFA), the 47-flag feature-flag catalog, voice agent + post-call
summary, PennPilot admin assistant, chatbot/sleep-coach/SMS-classifier
LLM routing, email auto-reply, provider portal + e-sign, FHIR/fax/
video-visit endpoints, and all ~60 pg-boss worker jobs.

## Findings (none blocking)

1. **Toolchain is strictly enforced.** `engines` pins Node 24.x +
   pnpm ≥11; on a machine with an older toolchain every `pnpm` script
   hard-fails (`ERR_PNPM_UNSUPPORTED_ENGINE`). Not a bug — but session
   environments need Node 24 + corepack-managed pnpm 11.5.2 on PATH
   before any check will run.
2. **IPv4-only environments can't boot the API.** The listener binds
   `::` by design (Railway dual-stack, hosting review R3) with no
   override; in a sandbox without IPv6 the bind fails `EAFNOSUPPORT`.
   Intentional for production; worth knowing for local smoke tests.
3. **67 admin mutations still use coarse `requireAdmin`** (vs
   `requirePermission`). All gated — zero public mutations — this is
   the known migration backlog the gate auditor prints, not a
   regression.

No functional defects found in the verification pass itself.

## Addendum (same day): finding 3 triaged and partially fixed

A follow-up pass classified all 67 flagged mutations. The bucket is
mostly NOT a backlog:

- **~50 use `requireAdminOnly`** (super-admin only) — stricter than any
  catalog permission swap; the auditor just can't distinguish the two
  spellings. No change needed (a `requirePermission` rewrite would be
  cosmetic or would _loosen_ access).
- **Deliberately all-staff, documented in-file:** MFA self-service,
  `agent-availability/me`, PennPilot assistant chat, the shared company
  calendar ("every staff member can VIEW and EDIT"), alert **send**
  (CSRs send alerts; editing copy is already `admin.tools.manage`), and
  video visits (CSRs schedule, clinicians join/complete — no existing
  permission covers that union). Left as-is.
- **One genuine inconsistency, fixed:** `routes/admin/pacware.ts`. The
  runbook and the `/admin/pacware` page are `admin.tools.manage`-tier,
  and the file's own status/settings endpoints carry that gate — but
  the bulk patient **import** (mass `patients` writes) and the four PHI
  roster **export/preview** GETs were plain `requireAdmin` (any staff).
  All five now require `admin.tools.manage`, with regression tests
  locking in the 403 for CSR-tier sessions.
