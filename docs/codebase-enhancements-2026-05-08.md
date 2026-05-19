# Codebase Enhancements — Triage Plan — 2026-05-08

**Branch:** `claude/review-codebase-enhancements-qA6iq`
**Scope:** Triage of 56 enhancement candidates surfaced in a fresh review pass,
combined with prior items from `docs/deep-bug-audit-2026-05-05.md` (D-BA) and
`docs/app-review-2026-05-06.md` (APP-R).
**Method:** Each input claim was opened against the live tree and classified
**Confirmed**, **Partial**, **Stale (already fixed)**, or **Reframed**. The
plan below carries forward only items that still apply, with severity, effort
(S = <1d, M = 1–3d, L = multi-PR), and a one-line sketch of the fix.

---

## TL;DR

> **Update 2026-05-13:** see the
> [refresh](./app-review-2026-05-13.md) for current status of every item
> below + 5 new findings from the recent feature wave.

- **4 items dropped** as already addressed (idempotency response capture;
  Stripe webhook middleware order; Stripe customer create idempotency key;
  CSRF timing side-channel).
- **56 items carried forward**, grouped P0–P3 (P0 7 + P1 12 + P2 21 + P3 16).
- **P0 (7 items)**: schema-deploy correctness + the loudest security gaps.
  Estimated 5–8 engineer-days. Should land before any further feature work
  that touches migrations or money flows.
- **P1 (12 items)**: reliability + database integrity. ~10–14 engineer-days.
- **P2 (21 items)**: performance, code quality, UX/a11y. Mostly bounded
  refactors; SPA decomposition is the largest single chunk (~3–5 weeks across
  4 files).
- **P3 (16 items)**: DX, observability, docs. Rolling backlog.

---

## Validation results — items dropped

These four appeared in the input list but are no longer applicable. They
should not enter the new backlog:

| #              | Input claim                                                                       | Status                        | Evidence                                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reliability #2 | Idempotency middleware doesn't capture `res.send`/`res.end`/streamed (Prior B-04) | **Stale — fixed**             | `artifacts/resupply-api/src/middlewares/idempotency.ts:199-201` patches all three; streaming covered via `res.end`.                                                                                                                                                                                 |
| Security #6    | Stripe webhook raw-body ordering risk                                             | **Reframed**                  | `artifacts/resupply-api/src/app.ts:132` registers `express.raw({type:'application/json',limit:'256kb'})` for `/resupply-api/stripe/webhook` BEFORE `express.json()` at `:138`. Order is correct. Carry forward only the regression-test action (P0.5).                                              |
| Reliability #8 | Stripe customer creation idempotency keys absent (Prior B-10)                     | **Partial — main path fixed** | `artifacts/resupply-api/src/lib/stripe/customer.ts:80-90` passes `idempotencyKey: \`pennpaps-shop-customer-${args.customerId}\``. Carry forward only the audit of other Stripe mutation call sites (P1.11).                                                                                         |
| Security #2    | CSRF token timing side-channel — early-exit on length mismatch (Prior D-BA A-01)  | **Stale — fixed**             | `lib/resupply-auth/src/csrf.ts:44-50` pads both sides to 128 bytes, runs `timingSafeEqual` on the padded buffers, and folds in the length check as a separate boolean. Tests at `csrf.test.ts:21-52`. Landed in commit `e2b6437` (sprint-1 audit fixes). Item P0.4 in the original plan is dropped. |

---

## P0 — Land first (schema-deploy + loudest security)

| #        | Item                                                                                                           | Sev  | Effort | File / evidence                                                                                                                                    | Sketch                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0.1     | Drizzle journal drift: 52 journal entries vs **73 SQL files**                                                  | HIGH | M      | `lib/resupply-db/drizzle/meta/_journal.json` last entry is `0049_physician_fax_outreach_status_pending_idx`; everything `0050…0066` is journalless | After P0.2, run `pnpm --filter @workspace/resupply-db run generate` to rebuild snapshot; verify `scripts/check-drizzle-drift.sh` passes.                                                                                 |
| P0.2     | **Six duplicate migration prefixes** (0016, 0017, 0049, 0050, 0052, 0065)                                      | HIGH | M      | `lib/resupply-db/drizzle/` — `ls \| awk -F_ '{print $1}' \| sort \| uniq -d` returns 6 collisions                                                  | Decide canonical apply order per pair (smallest blast radius: rename newer file `00NN`→`00NN+0.5` then regenerate journal); coordinate with anyone holding open PRs that touch these prefixes.                           |
| P0.3     | No CI workflow runs `typecheck`/`lint`/tests/drizzle-drift                                                     | HIGH | S–M    | `.github/workflows/` only contains `copilot-setup-steps.yml`                                                                                       | Add `.github/workflows/ci.yml` with jobs for `pnpm install`, `pnpm typecheck`, `pnpm lint:resupply`, `pnpm -r test`, and the four `scripts/check-*.sh`. Required check on PRs.                                           |
| ~~P0.4~~ | ~~CSRF token timing side-channel~~                                                                             | —    | —      | —                                                                                                                                                  | **Dropped — already fixed.** See "Validation results" above.                                                                                                                                                             |
| P0.5     | No regression test guarding Stripe webhook raw-body ordering                                                   | HIGH | S      | `artifacts/resupply-api/src/app.ts:132` (correct today)                                                                                            | Add a test that posts to `/resupply-api/stripe/webhook` with a JSON payload, mocks the handler to capture `req.body`, and asserts `Buffer.isBuffer(req.body)` so a future middleware reorder fails CI.                   |
| P0.6     | Auth-recovery rate-limits incomplete: `forgot-password`, `reset-password`, `verify-email` (Prior D-BA B-02/03) | HIGH | S      | Per prior audit                                                                                                                                    | Wire the existing `lib/resupply-auth` rate-limiter (already used on sign-in) onto these three routes; per-IP **and** per-email keys.                                                                                     |
| P0.7     | Admin write-path per-actor rate-limits missing on most mutations (Prior D-BA B-07)                             | HIGH | M      | Per prior audit                                                                                                                                    | Add a small `adminRateLimit(req)` middleware keyed by `actor.userId`; default 60/min for write verbs; opt-in per route.                                                                                                  |
| P0.8     | Duplicate router registration causing double-execution (Prior D-BA B-01)                                       | HIGH | S      | Per prior audit                                                                                                                                    | Identify the duplicated `app.use(...)` lines in `artifacts/resupply-api/src/app.ts` (or per-router `mount()` wrappers), remove the duplicate, add a startup assertion that no `(method, path)` pair is registered twice. |

**P0 rollup:** ~5–8 engineer-days. P0.1 + P0.2 are coupled (do P0.2 first;
P0.1 is its tail). P0.3 is independent and unblocks visible CI signal for the
remaining work. P0.5 is a single-file test that pins behaviour already
implemented correctly.

**Note on `lint:resupply` baseline.** As of 2026-05-08 the
`facialMeasurementsInfo` import in `artifacts/resupply-api/src/routes/shop/me-clinical-info.ts:38`
is unused (introduced in commit `fb6c8a5` on 2026-05-07) and breaks
`pnpm lint:resupply`. The CI workflow being added under P0.3 cannot go
green until this is removed; the cleanup ships as a one-line companion
commit to P0.3.

---

## P1 — Next (reliability + database integrity)

| #     | Item                                                                    | Sev  | Effort | File / evidence                                                                                                                                                   | Sketch                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1.1  | No transaction around order create + facial-measurement mirror          | MED  | S      | `artifacts/resupply-api/src/routes/storefront/orders.ts:97` (insert) and `:174` (mirror update) are sequential awaits                                             | Wrap the two writes in `db.transaction(async (tx) => {...})`; pass `tx` to existing helpers.                                                                                                                    |
| P1.2  | Worker has no DLQ / job-failure alerting                                | HIGH | M      | `artifacts/resupply-api/src/worker/index.ts:65` only registers a generic `boss.on("error")`; no `failed`/`onComplete` handler, no per-job retry budget visibility | Subscribe to pg-boss `failed` event; on failure, write structured log + audit row + (when configured) page via existing alert path. Surface `pgboss.archive` rows in admin dashboard.                           |
| P1.3  | CSRF missing on storefront state-changing endpoints (cookie-only auth)  | MED  | M      | `artifacts/resupply-api/src/routes/storefront/orders.ts:44` uses only `attachSignedIn`; no CSRF middleware                                                        | Apply existing CSRF middleware to all state-changing storefront routes, or add a SameSite=Strict cookie + Origin check. Note Order endpoint accepts orders from any origin holding a `pf_session` cookie today. |
| P1.4  | Fax status callback body cast to `Record<string,string>` instead of Zod | MED  | S      | `artifacts/resupply-api/src/routes/fax/status-callback.ts:72` does `(req.body ?? {}) as Record<string,string>`                                                    | Define `faxStatusCallbackSchema` in the same file; parse on entry; treat parse failure as 400.                                                                                                                  |
| P1.5  | Session cookie config not centrally asserted                            | MED  | S      | `lib/resupply-auth` cookie creation lacks a single test asserting `HttpOnly`, `Secure`, `SameSite`, TTL                                                           | Add `cookie-config.test.ts` covering each session-issuing path; flip on env-aware Secure behavior.                                                                                                              |
| P1.6  | Admin lookup regex hardening — `STRIPE_SESSION_RE` lacks max-length cap | MED  | S      | `artifacts/resupply-api/src/routes/admin/lookup.ts:52` `/^cs_[a-zA-Z0-9_]{20,}$/` is unbounded                                                                    | Cap at `{20,128}` (or actual Stripe max). Other regexes in the file already have caps.                                                                                                                          |
| P1.7  | External API retries (Stripe/SendGrid/Twilio)                           | MED  | M      | `artifacts/resupply-api/src/lib/stripe/webhook-handler.ts:470`, SendGrid order-confirmation send, Twilio sends — single-attempt                                   | Wrap each external call with a small retry policy (exponential backoff, max 3 tries, idempotency keys for Stripe). Circuit-breaker is optional.                                                                 |
| P1.8  | `writeAudit` swallows errors with no alerting                           | MED  | S      | `artifacts/resupply-api/src/routes/storefront/admin-users.ts:46-61` — silent catch                                                                                | Add a sampled error-log path; emit a metric on persistent audit-write failure.                                                                                                                                  |
| P1.9  | Reminder job invalid-date propagation (Prior D-BA B-06)                 | MED  | S      | Per prior audit                                                                                                                                                   | Add Zod parse of inbound date strings; on parse failure, mark job failed and log instead of silently scheduling for "Invalid Date".                                                                             |
| P1.10 | `shop_orders.customerId` has no foreign key                             | MED  | S      | `lib/resupply-db/src/schema/shop-orders.ts:89` — bare `text("customer_id")`                                                                                       | Add `.references(() => shopCustomers.id, { onDelete: "restrict" })`; ship as a paired migration.                                                                                                                |
| P1.11 | Audit Stripe mutations for missing idempotency keys                     | MED  | S      | Customer create has key; other call-sites unverified                                                                                                              | Grep `stripe\.\w+\.(create\|update\|cancel)` and add idempotency keys where missing, especially refund + subscription paths.                                                                                    |
| P1.12 | Audit table has no PHI-redaction sweep policy                           | MED  | M      | `audit_logs` (no retention/redaction job today)                                                                                                                   | Define retention policy (e.g., 7 years for clinical, 90d for non-PHI request bodies); implement worker job to redact body fields older than threshold.                                                          |

**P1 rollup:** ~10–14 engineer-days. P1.2 + P1.7 + P1.8 form a coherent
"reliability v1" mini-PR set.

---

## P2 — Code quality + performance + UX/a11y

### Code quality / decomposition (largest velocity tax)

| #    | Item                                                         | Sev | Effort | File / evidence                                                              | Sketch                                                                                                     |
| ---- | ------------------------------------------------------------ | --- | ------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P2.1 | `patient-detail.tsx` 3,948 LOC                               | MED | L      | `artifacts/cpap-fitter/src/pages/admin/patient-detail.tsx`                   | Split by tab: `OverviewTab`, `OrdersTab`, `MessagesTab`, `DocumentsTab`, etc.; lift hooks; one PR per tab. |
| P2.2 | `account.tsx` 1,918 LOC                                      | MED | M–L    | `artifacts/cpap-fitter/src/pages/account.tsx`                                | Same approach: extract sub-pages by section.                                                               |
| P2.3 | `patients.tsx` 1,694 LOC                                     | MED | M      | `artifacts/cpap-fitter/src/pages/admin/patients.tsx`                         | Extract list, filter, pagination, row-actions modules.                                                     |
| P2.4 | `shop-product-detail.tsx` 1,480 LOC                          | MED | M      | `artifacts/cpap-fitter/src/pages/shop-product-detail.tsx`                    | Extract gallery, options, reviews, compatibility into siblings.                                            |
| P2.5 | `admin/customers.ts` 1,062 LOC mixes list/detail/pagination  | LOW | M      | `artifacts/resupply-api/src/routes/admin/customers.ts`                       | Split into `customers/list.ts`, `customers/detail.ts`; keep router top-level.                              |
| P2.6 | `maskCatalog.ts` 1,589 LOC of static data lives in code      | MED | M      | `artifacts/resupply-api/src/data/maskCatalog.ts`                             | Move to a `mask_catalog` table seeded from JSON; keep TS types from a generated file.                      |
| P2.7 | Inconsistent loading-state naming (`loading` vs `isPending`) | LOW | S      | e.g., `artifacts/cpap-fitter/src/pages/shop.tsx:157`                         | ESLint codemod / find-replace; document the convention in `cpap-fitter/CONVENTIONS.md`.                    |
| P2.8 | Inconsistent error-response shape                            | LOW | S      | `artifacts/resupply-api/src/routes/storefront/chat.ts:249-256` vs `:263-267` | Adopt a single `{error: {code, message, details?}}` envelope helper.                                       |
| P2.9 | `AuthUserRow`/`MemberRow` re-declared per route              | LOW | S      | `artifacts/resupply-api/src/routes/admin/admin-users.ts:63-90`               | Move to `lib/resupply-auth/src/types.ts` and import.                                                       |

### Performance

| #     | Item                                                            | Sev | Effort | File / evidence                                                                | Sketch                                                                                            |
| ----- | --------------------------------------------------------------- | --- | ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| P2.10 | No composite index `(status, created_at desc)` on `shop_orders` | LOW | S      | `lib/resupply-db/src/schema/shop-orders.ts`                                    | Drizzle schema `index().on(table.status, sql\`${table.createdAt} desc\`)`; ship a migration.      |
| P2.11 | Chatbot knowledge cached at module init (1,348 LOC)             | LOW | S      | `artifacts/resupply-api/src/lib/storefront/chatbotKnowledge.ts`                | Add 10-min TTL or admin-trigger refresh endpoint guarded by audit.                                |
| P2.12 | No bundle-size budgets / visualizer for `cpap-fitter`           | LOW | S      | `artifacts/cpap-fitter/vite.config.ts:69-86`                                   | Add `rollup-plugin-visualizer` + `vite-bundle-analyzer`; configure `build.chunkSizeWarningLimit`. |
| P2.13 | `getCsrfToken()` retrieved 6× in `shop-api.ts`                  | LOW | S      | `artifacts/cpap-fitter/src/lib/shop-api.ts` lines 183, 350, 380, 399, 654, 696 | Wrap fetches in `apiFetch(method, path, body)` helper that injects header + token.                |

### UX / accessibility (cpap-fitter)

| #     | Item                                                                       | Sev | Effort | File / evidence                                                      | Sketch                                                                                                 |
| ----- | -------------------------------------------------------------------------- | --- | ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P2.14 | Order submit button doesn't disable on `isPending`                         | MED | S      | `artifacts/cpap-fitter/src/pages/order.tsx:143`                      | Add `disabled={mutation.isPending}` + spinner. Prevents double-submit.                                 |
| P2.15 | No error boundary around streaming chat                                    | MED | S      | `artifacts/cpap-fitter/src/components/customer-chat-section.tsx`     | Wrap with React `ErrorBoundary` that resets stream state.                                              |
| P2.16 | Destructive admin actions (returns/refunds) likely lack confirm dialogs    | MED | S      | `artifacts/cpap-fitter/src/pages/admin/shop-returns.tsx` (verify)    | Audit each destructive action; require typed-confirmation for refunds >threshold.                      |
| P2.17 | Chat "thinking" indicator lacks `aria-live="polite"`                       | LOW | S      | `artifacts/cpap-fitter/src/components/customer-chat-section.tsx:489` | Add `aria-live="polite"` + `aria-atomic="true"`.                                                       |
| P2.18 | Form fields don't bind `aria-invalid`                                      | LOW | S      | `artifacts/cpap-fitter/src/pages/order.tsx:145-175`                  | Bind to validation error state; expand to other forms via codemod.                                     |
| P2.19 | Admin localStorage drafts have no TTL or "stored locally" UX (Prior P2-10) | LOW | S      | `artifacts/cpap-fitter/src/lib/admin/use-draft-autosave.ts`          | Stamp drafts with `savedAt`; expire after N days; surface a "Draft from <relative time>" hint on load. |

### Database (carryover)

| #     | Item                                                                                     | Sev | Effort | File / evidence                                                 | Sketch                                                                                             |
| ----- | ---------------------------------------------------------------------------------------- | --- | ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P2.20 | Conditional NOT NULL not modeled on `shop_orders.amountTotalCents` once `paid_at` is set | LOW | S      | `lib/resupply-db/src/schema/shop-orders.ts`                     | Add a CHECK constraint via raw SQL migration: `paid_at IS NULL OR amount_total_cents IS NOT NULL`. |
| P2.21 | `cart_hash` partial unique index in SQL only, not in Drizzle schema                      | LOW | S      | `lib/resupply-db/drizzle/0062_shop_orders_cart_hash_unique.sql` | Mirror in Drizzle schema with `uniqueIndex(...).where(...)` so the drift script can see it.        |

**P2 rollup:** ~25–35 engineer-days, dominated by SPA decomposition (P2.1–P2.4).

---

## P3 — DX, observability, docs

### DX / tooling

| #    | Item                                                                                                   | Sev | Effort | Sketch                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------ | --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3.1 | `cpap-fitter` now appears to be in ESLint scope; lint cleanup/enforcement should be tracked explicitly | MED | M      | `eslint.config.mjs` already includes `artifacts/cpap-fitter/src/**/*.{ts,tsx}`; reframe this as staged violation burn-down and CI enforcement follow-up, not exclusion removal. |
| P3.2 | No Lighthouse / axe CI for SPA a11y regressions                                                        | MED | M      | Add a Playwright + axe-core job to the CI workflow added in P0.3.                                                                                                               |
| P3.3 | Playwright E2E exists but no smoke run on PRs                                                          | LOW | S      | Wire `pnpm playwright test --grep @smoke` into the CI workflow.                                                                                                                 |
| P3.4 | No bundle-budget gate in CI                                                                            | LOW | S      | After P2.12 lands, fail CI on >X% bundle growth.                                                                                                                                |
| P3.5 | Package-manager metadata could be tightened (`engines.pnpm` / `engines.node`)                          | LOW | S      | Keep the existing `packageManager: pnpm@10.33.2` pin and add `engines.pnpm`/`engines.node`.                                                                                     |
| P3.6 | `preinstall` silently `rm -f`s lockfiles                                                               | LOW | S      | Replace with a guard that errors if a non-pnpm lockfile is present and instructs the developer.                                                                                 |

### Observability

| #     | Item                                                | Sev | Effort | Sketch                                                                                                        |
| ----- | --------------------------------------------------- | --- | ------ | ------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- |
| P3.7  | No request-ID / correlation-ID propagation          | MED | M      | Add `pino-http` `genReqId`; surface via `AsyncLocalStorage` for cross-step traces; include in audit rows.     |
| P3.8  | Worker-triggered audit rows have `actorEmail: null` | LOW | S      | `artifacts/resupply-api/src/worker/jobs/reminders.ts:200` — set `actorEmail: "system:reminders.scan"`.        |
| P3.9  | No external-API latency histograms                  | LOW | M      | Wrap Stripe/SendGrid/Twilio/OpenAI clients with a `withMetrics(name)` helper that emits histograms.           |
| P3.10 | Stripe 500-path raw error not captured              | LOW | S      | `artifacts/resupply-api/src/lib/stripe/webhook-handler.ts:351-360` — log full error body keyed by request-id. |
| P3.11 | Refund event lacks "why" attribution                | LOW | S      | Audit row `metadata` → `{initiator: "admin"                                                                   | "customer" | "system", reason: <enum>}`. |

### Documentation

| #     | Item                                                                                                      | Sev | Effort | Sketch                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------- | --- | ------ | ----------------------------------------------------------------------------------------------------------- |
| P3.12 | No worker-recovery runbook                                                                                | MED | S      | `docs/runbooks/worker-recovery.md` — replay failed pg-boss jobs, clear stuck queues, drain DLQ.             |
| P3.13 | Admin-theme `.admin-root` rule has no enforcement test                                                    | LOW | S      | Add a Playwright check that admin pages have `.admin-root` ancestor; or an ESLint rule on `pages/admin/**`. |
| P3.14 | Stripe webhook event-handler matrix not documented                                                        | LOW | S      | `docs/integrations/stripe-events.md` — table of `event.type` → handler → mutated tables.                    |
| P3.15 | No ADRs for: pg-boss in-process choice, removal of column-level PHI encryption, single From-address, etc. | LOW | S each | Backfill ADRs as `docs/adr/0001-...`; one-pager each.                                                       |
| P3.16 | `RESUPPLY_LINK_HMAC_KEY` rotation runbook missing                                                         | LOW | S      | Document key rotation: emit signed-with header, accept previous key for overlap window N, retire old key.   |

---

## Effort rollup

| Tier      | Items  | S   | M   | L   | Approx engineer-days |
| --------- | ------ | --- | --- | --- | -------------------- |
| P0        | 7      | 3   | 4   | 0   | 5–8                  |
| P1        | 12     | 7   | 5   | 0   | 10–14                |
| P2        | 21     | 13  | 4   | 4   | 25–35                |
| P3        | 16     | 11  | 5   | 0   | 8–12                 |
| **Total** | **56** | 34  | 18  | 4   | **48–69**            |

(P3 has 16 entries because the input's "ADRs" line was kept as a single
ticket with multiple S sub-tasks.)

---

## Suggested PR sequence

**Wave 1 — Schema + visible CI signal (1 sprint):**
P0.2 → P0.1 (paired) → P0.3 (CI workflow) → P0.5 (Stripe ordering test). Lands
within ~1 week. Gives the team passing CI on every PR and closes the
schema-deploy hazard. (P0.4 is already done — see "Validation results".)

**Wave 2 — Auth + admin write rate-limits (~½ sprint):**
P0.6 → P0.7 → P0.8. All in `artifacts/resupply-api/src/middlewares/`; can ship
as one PR with three commits.

**Wave 3 — Reliability v1 (~1 sprint):**
P1.2 (worker DLQ + alerting) → P1.7 (external retries) → P1.8 (audit failure
alerting) → P1.1 (order transaction). One coherent PR set.

**Wave 4 — Database integrity (~½ sprint):**
P1.10 (FK) → P2.20 (CHECK constraint) → P2.21 (cart_hash schema mirror) →
P2.10 (composite index). All paired schema + migration; one PR.

**Wave 5 — SPA decomposition (multi-sprint, parallelizable):**
P2.1–P2.4. One PR per tab/section. Avoid touching during Wave 1–4 to keep
diffs reviewable.

**Wave 6 — Rolling DX/docs/observability:**
P3 items absorbed alongside other work; no dedicated sprint.

---

## Open questions (need product/eng input before scheduling)

1. **P1.12 audit retention policy** — what's the legal retention window for
   PHI-tagged audit rows? Plan assumes 7 years clinical / 90d non-PHI bodies;
   confirm with compliance.
2. **P2.6 maskCatalog → table** — does product want runtime updates to mask
   catalog (admin UI) or is "data-as-code, edit + deploy" acceptable? Choice
   determines whether P2.6 ships with an admin editor.
3. **P0.2 duplicate prefixes** — any open PRs touching the affected migrations
   (0016, 0017, 0049, 0050, 0052, 0065)? Renaming will conflict with them.
4. **P0.3 CI** — does the team want a single `ci.yml` or split into
   `lint.yml` / `test.yml` / `drift.yml` for parallel jobs?

---

## Appendix — input items not in the new plan

| Input claim                                  | Reason                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Reliability #2 (idempotency capture)         | Already implemented; see "Validation" above.                                               |
| Security #6 (Stripe ordering risk)           | Reframed as P0.5 (regression test only).                                                   |
| Reliability #8 (Stripe customer idempotency) | Main path already does this; remainder folded into P1.11.                                  |
| DX #2 (pre-commit hooks for codegen/drift)   | Already implemented in `scripts/git-hooks/pre-commit`. The gap is CI (P0.3), not the hook. |
