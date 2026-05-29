# PennFit App Review — 2026-05-06

## Scope reviewed

- Monorepo architecture and scripts (`README.md`, root `package.json`).
- Existing deep bug/security audit (`docs/deep-bug-audit-2026-05-05.md`).
- Static pattern scan across API, frontend, and shared libraries.
- Baseline quality gates (`pnpm lint:resupply`, `pnpm typecheck`).

## Overall assessment

The app has strong foundations (strict linting, type safety, broad tests, thoughtful privacy posture), but there are several **high-priority reliability and security risks** that should be treated as immediate fixes before additional feature work.

---

## Priority 0 (Fix immediately)

1. **Duplicate route registration in Express app**
   - Causes double middleware/handler execution for a set of admin routes.
   - Risk: duplicate writes, duplicate audit rows, accidental double side-effects.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-01).

2. **Missing rate limiting on auth recovery flows**
   - `forgot-password` and `verify-email` lack robust throttling.
   - Risk: abuse, email flooding, account enumeration pressure.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-02, B-03).

3. **CSRF comparison timing side-channel**
   - Token length mismatch exits early before constant-time compare.
   - Risk: incremental oracle leakage in high-volume probing.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (A-01).

4. **Idempotency middleware incompletely captures response methods**
   - Middleware captures `res.json` but not all response pathways.
   - Risk: replayed state changes on retries for non-JSON responses.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-04).

---

## Priority 1 (Next sprint)

5. **Admin write-path abuse controls are incomplete**
   - Many mutation endpoints are not rate-limited per actor.
   - Risk: compromised admin session can trigger bulk operational damage.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-07).

6. **Stripe resilience/idempotency gaps**
   - Customer creation path needs explicit idempotency keys.
   - Risk: duplicate Stripe customers during retry races.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-10).

7. **Webhook hardening gaps**
   - Content-type and malformed payload handling can be stricter.
   - Risk: dropped events without replay.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-12).

8. **Potential invalid-date propagation in reminder job**
   - Date math path may treat invalid baselines as due-now.
   - Risk: erroneous reminder dispatch.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-06).

---

## Priority 2 (Enhancements and hardening)

9. **Auditability improvements for auth failure reasons**
   - Add structured reason codes for non-password rejection paths.
   - Source: `docs/deep-bug-audit-2026-05-05.md` (B-15).

10. **Frontend PHI hygiene follow-up**

- Static scan shows intentional `localStorage` use in admin draft workflows.
- Enhance with configurable short TTL and explicit “local draft stored” UX.
- Evidence files:
  - `artifacts/cpap-fitter/src/lib/admin/use-draft-autosave.ts`
  - `artifacts/cpap-fitter/src/pages/admin/conversation-detail.tsx`

11. **Type-safety debt hotspots**

- Small number of explicit `any`/eslint suppressions remain in UI shims and advanced internals.
- This appears deliberate but should be tracked with an owner and retirement plan.

---

## What I validated in this review

- `pnpm lint:resupply` passes.
- `pnpm typecheck` passes.
- Existing deep audit already catalogs 79 items with severity and direct file pointers.

## Recommended execution plan

1. Resolve all Priority 0 items behind one hardening epic.
2. Add security regression tests for each fixed auth/idempotency/route issue.
3. Roll out Priority 1 changes with observability metrics (rate-limit hit counts, webhook parse error counters).
4. Track Priority 2 as reliability/privacy debt items with owners.
