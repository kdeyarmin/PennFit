# Engineering workflow & process efficiency audit — 2026-06-04

**Branch:** `claude/workflow-efficiency-audit-QugGD`
**Scope:** the _developer / engineering_ workflow — CI pipeline,
git hooks, local dev loop, build/test commands, agent-session setup, and
the drift-check scripts. This is deliberately the gap left by the prior
audits:

- `AUDIT_REPORT.md` (2026-05-04) covered code quality / dead code / lint.
- `docs/process-simplification-review-2026-05-21.md` covered the
  **user-facing** product process and explicitly left the
  "Git/migration drift hooks — orthogonal to user-facing process" alone.

Nothing here touches a `CLAUDE.md` hard rule (no PHI/logging,
Supabase-only data path, admin theme scoping, decoupled service boot,
etc.) — these are pure build/CI/dev-loop changes.

---

## Summary

| #   | Finding                                                       | Severity | Status                          |
| --- | ------------------------------------------------------------- | -------- | ------------------------------- |
| W1  | CI bootstrap (pnpm+Node+install) copy-pasted into 9 jobs      | HIGH     | ✅ fixed (composite action)     |
| W2  | Playwright browser downloaded twice/run, never cached         | MEDIUM   | ✅ fixed (cache step)           |
| W3  | SPA built twice per CI run (a11y + smoke)                     | MEDIUM   | open — recommendation below     |
| W4  | `results-page-resilience.spec.ts` runs in no CI job           | MEDIUM   | ✅ fixed (new `e2e-dev` job)    |
| W5  | Shell-script test files (`*.sh.test`) execute nowhere         | MEDIUM   | ◑ partial — 1 of 4 wired in     |
| W5a | The architecture-guard test has rotted (stale `resupply-worker`) | MEDIUM | open — **new finding**, below   |
| W6  | No single "run what CI runs" local command                   | LOW      | open — recommendation below     |
| W7  | Hooks not auto-installed on fresh clone (only post-merge)     | LOW      | open — recommendation below     |
| W8  | `pnpm typecheck` runs in `build`, then again in CI standalone | INFO     | open — note                     |

Shipped on this branch: W1, W2 (mechanical CI DRY + caching), W4 (the
dev-server e2e job, soft-gated), and the validated slice of W5 (one of
four dormant guard tests wired in). Investigating W5 surfaced **W5a** —
the architecture-guard test has silently rotted against the May-2026
artifact consolidation — which is the most important finding here and is
left for a focused maintainer pass because it touches a correctness-
critical script. The remaining items (W3, W6, W7, W8 and the other two
shell tests) are left **open** with a fix sketch.

---

## Fixed on this branch

### [HIGH] W1 — CI toolchain bootstrap duplicated across 9 jobs

**Before.** Every CI job repeated the same ~15-line block verbatim:

```yaml
- name: Install pnpm
  run: |
    corepack disable pnpm 2>/dev/null || true
    npm install -g pnpm@${{ env.PNPM_VERSION }}
    pnpm --version
- uses: actions/setup-node@v5
  with:
    node-version: ${{ env.NODE_VERSION }}
    cache: "pnpm"
    cache-dependency-path: pnpm-lock.yaml
- run: pnpm install --frozen-lockfile
```

That block appeared **7× in `ci.yml`** (lint-typecheck, drift, test,
migrations, integration, a11y, smoke) and again in `schema-drift.yml`
and `copilot-setup-steps.yml` — 9 copies total. The pnpm-version pin,
the corepack-disable workaround, and the cache config all had to be
kept in sync by hand across all 9. (The corepack rationale was a
20-line comment that lived in three places.)

**Fix.** Extracted `.github/actions/setup/action.yml` (a local
composite action) that does the pnpm install → setup-node → frozen
install, with `node-version` / `pnpm-version` / `install` inputs. Each
job now reads:

```yaml
- uses: actions/checkout@v5
- uses: ./.github/actions/setup
  with:
    node-version: ${{ env.NODE_VERSION }}
    pnpm-version: ${{ env.PNPM_VERSION }}
```

`checkout` stays in the job (a local composite action can only resolve
after the repo is on disk). Net: `ci.yml` 469 → 419 lines, and the
toolchain pin / corepack workaround now live in exactly one file.

**Risk.** Low. Behavior is identical (same versions, same commands,
same cache key). The PR's own CI run validates it end-to-end.

### [MEDIUM] W2 — Playwright chromium re-downloaded every run, never cached

**Before.** Both the `a11y` and `smoke` jobs ran
`pnpm exec playwright install --with-deps chromium` with no cache, so
chromium (~100 MB + browser deps) was downloaded **twice per CI run**
and **every run**.

**Fix.** Added an `actions/cache@v4` step before the install in both
jobs, keyed `${{ runner.os }}-playwright-${{ hashFiles('pnpm-lock.yaml') }}`
(the lockfile hash changes exactly when the Playwright version does).
On a hit, `playwright install` skips the binary download; only the fast
OS-dependency apt step runs. Both jobs share the key, so chromium is
fetched at most once per run and reused across runs until the
Playwright version bumps.

**Risk.** Low. A cold/stale cache just falls back to a full download
(today's behavior).

---

## Open recommendations (judgement calls left to the maintainer)

### [MEDIUM] W3 — The SPA is built twice per CI run

`a11y` and `smoke` each run `pnpm --filter @workspace/cpap-fitter run
build` (the single most expensive CI step) on separate runners. The
jobs are deliberately kept separate so each reports an independent
signal (`smoke` is required; `a11y` is `continue-on-error`), so
**merging them is the wrong fix** — it would couple a soft gate to a
hard one.

**Sketch.** Build once in a tiny `build-spa` job, upload
`artifacts/cpap-fitter/dist` via `actions/upload-artifact`, and have
`a11y` + `smoke` `needs: build-spa` and download it. Keeps both signals
independent while removing the duplicate Vite build. Trade-off: adds
artifact upload/download latency (~seconds) and a job dependency; only
worth it if the SPA build is slow enough that the duplication hurts
wall-clock time. Measure first (`build-spa` duration in a recent run)
before committing to this.

### [MEDIUM] W4 — `results-page-resilience.spec.ts` ran in no CI job → **fixed**

`e2e/tests/` contains three specs, and only two were wired in:

- `a11y.spec.ts` → `a11y` job
- `storefront-loads.spec.ts` → `smoke` job
- `results-page-resilience.spec.ts` → **was run by nothing**

The third is a real regression guard (the `/results` page must not trip
the `ErrorBoundary` when `/api/masks` returns non-JSON during a deploy
window). It explicitly **requires the Vite _dev_ server** — it stubs the
`@mediapipe/tasks-vision` ES module by intercepting the module request,
which only exists as a separate fetch when modules are served unbundled
(dev). Under `vite preview` (what `smoke`/`a11y` use) the module is
bundled, the stub can't take effect, and the spec self-skips. So adding
it to the existing preview-based jobs would just make it skip — it
needed a dev-server job.

**Fix.** Added an `e2e-dev` job that pre-downloads the MediaPipe model,
boots `vite dev` (unbundled), and runs the spec. Marked
`continue-on-error` while it proves itself in CI — it has never run here
and a mocked-camera fitter walk is the most timing-sensitive thing in
the suite; this mirrors the soft-gate pattern of the `integration` and
`a11y` jobs. Flip to required once it's been green across a few runs.

### [MEDIUM] W5 — Shell-script guard tests execute nowhere → **1 of 4 wired in**

`scripts/` ships substantial test files for its bash guards that no
pipeline ran:

| Test file                                  | Size  | Tests its sibling                    | Status                              |
| ------------------------------------------ | ----- | ------------------------------------ | ----------------------------------- |
| `check-admin-route-gates.sh.test`          | 5.7 KB| `check-admin-route-gates.sh`         | ✅ wired into the `drift` job       |
| `check-resupply-architecture.sh.test`      | 35 KB | `check-resupply-architecture.sh`     | ❌ rotted — see **W5a**             |
| `check-resupply-migration-prefix.sh.test`  | 6.3 KB| `check-resupply-migration-prefix.sh` | ⏸ deferred — git-commits (below)   |
| `git-hooks/lib-staged-snapshot.test`       | 11 KB | `lib-staged-snapshot.sh`             | ⏸ deferred — flaky scenario 9      |

`pnpm test` only runs the per-package vitest suites; CI's `drift` job
only ran `check-admin-route-gates.sh --self-test` (a self-test baked
into that one script, distinct from the fixture-driven `.sh.test`
harnesses). So coverage for the repo's most safety-critical guard
scripts was dormant.

**Fix (this branch).** Wired the fully-validated
`check-admin-route-gates.sh.test` (passes locally, no git-commit
fixtures) into the `drift` job. The other three are deferred for
concrete reasons:

- **`check-resupply-migration-prefix.sh.test`** builds a throwaway git
  repo and `git commit`s synthetic diffs into it. That's fine in GitHub
  Actions but can't be validated in every local/agent sandbox (some
  intercept `git commit` for signing). Wire it in once confirmed green
  on a CI runner.
- **`git-hooks/lib-staged-snapshot.test`** is **non-deterministic**:
  scenario 9 ("recovery-dir breadcrumb emitted before mutation") asserts
  the lib takes the snapshot path, but the lib's `git diff` capture
  intermittently reports no unstaged change (observed 5/5 fast-path in a
  bare run, but the breadcrumb fires once an intervening `git` command
  refreshes the index). Needs a deflake — likely a `git update-index
  --refresh` (or an explicit `git diff` warm-up) in either the lib's
  capture phase or the test setup — before it can gate CI.

### [MEDIUM] W5a — The architecture-guard test has rotted (new finding)

`check-resupply-architecture.sh.test` — the negative-test harness for
the repo's **primary architecture invariant checker** — fails on the
current `main`. It plants fixtures under `artifacts/resupply-worker/src`
and asserts the checker flags them, but `resupply-worker` was **folded
into `resupply-api` during the May-2026 consolidations** (the worker now
lives at `artifacts/resupply-api/src/worker/`). The checker's per-rule
directory lists were updated to drop the standalone `resupply-worker`
path; the test was not. The failures cascade (fixing the Rule 6 worker
case exposes the Rule 7 worker case, etc.), so ~7 `resupply-worker`
fixture cases are stale.

This is the exact danger dormant tests create: **the test for the
architecture guard no longer matches the guard, so the guard could
regress with nothing to catch it.** Reconciling it is a judgement call
per rule — does the checker intend to cover the worker (now under
`resupply-api/src`, which most rules already scan) or not? — and it
touches a correctness-critical script, so it's left for the maintainer
rather than mechanically "made green." A focused reconciliation PR
should: (1) repoint or drop each `resupply-worker` fixture case, (2)
confirm the real worker tree (`resupply-api/src/worker`) is covered by
the rules that matter, (3) drop the vestigial `resupply-dashboard`
fixtures + the checker's stale `resupply-dashboard/src` enumeration
entries, then (4) wire the test into the `drift` job alongside the
admin-gate harness.

### [LOW] W6 — No single "run exactly what CI runs" local command

A contributor wanting to pre-flight a PR locally has to know to run
`pnpm lint:resupply`, `pnpm typecheck`, `pnpm test`,
`scripts/check-resupply-architecture.sh`, and
`scripts/check-admin-route-gates.sh` by hand, in the right order. The
pre-commit hook runs a _subset_ (arch + migration-prefix + ts-syntax)
but not lint/typecheck/test.

**Sketch.** Add a root `package.json` script, e.g.:

```json
"verify": "pnpm lint:resupply && pnpm typecheck && pnpm test && scripts/check-resupply-architecture.sh && scripts/check-admin-route-gates.sh"
```

so `pnpm verify` mirrors the gating CI jobs in one command. Pure
convenience; no behavior change.

### [LOW] W7 — Git hooks only auto-install on `post-merge`

`scripts/install-hooks.sh` is invoked from `scripts/post-merge.sh`, so a
contributor picks up the hooks only _after their first merge_. A fresh
clone that hasn't merged yet commits with no architecture/migration/
ts-syntax guard. There's no `pnpm` lifecycle hook (`prepare`) wiring it
in on install.

**Sketch.** Two options, both low-risk:

- Add `"prepare": "bash scripts/install-hooks.sh"` to root
  `package.json` so `pnpm install` wires the hooks (the installer is
  already idempotent and no-ops outside a git repo). This is the
  conventional Husky-style entry point without adding Husky.
- Or just document `bash scripts/install-hooks.sh` as step 1 of local
  setup in `README.md` / `CLAUDE.md` (it's currently only mentioned in
  passing).

The installer's own header explains why it avoids Husky/lefthook
(agent environments wipe `node_modules`); a `prepare` script is
compatible with that reasoning since it re-runs on every install.

### [INFO] W8 — `typecheck` runs inside `build` and again as its own job

`pnpm build` is `pnpm run typecheck && pnpm -r run build`, so any job
that builds also typechecks. CI runs `typecheck` standalone in
`lint-typecheck` (correct — fast feedback) and Railway runs the full
`build` (which re-typechecks). Not a bug — just noting the work is done
twice across the deploy path. No action recommended; the standalone
typecheck is the right fast-feedback signal and Railway's rebuild is
independent infrastructure.

---

## What was checked and is already healthy

- **CI concurrency** is correctly configured (`cancel-in-progress` on
  `ci-${{ github.ref }}`) — rapid pushes don't pile up runners.
- **pnpm store caching** via `actions/setup-node` `cache: pnpm` is wired
  on every job (keyed on `pnpm-lock.yaml`).
- **The git-drift hooks** (`pre-commit` blocks commits to a stale local
  `main`; `pre-push` blocks non-fast-forward pushes to `origin/main`)
  are well-designed, fail-open on network errors, and have a documented
  `SKIP_HOOKS=1` escape hatch. No change needed.
- **The pnpm-lock merge driver** (`merge=pnpm-lock` + post-merge/
  post-rewrite reconcile) is a thoughtful solution to the lockfile
  merge-train friction; the committed `.gitattributes` fallback is
  correct for the server side.
- **Supply-chain posture**: `minimumReleaseAge: 1440` (24 h) in
  `pnpm-workspace.yaml` plus pinned overrides; `pnpm audit` is wired as
  a root script.
- **Live schema-drift detection** runs on a daily cron with a clean
  no-op when the read-only DB secret is absent.

---

## Suggested next step

W1, W2, W4, and the validated slice of W5 are on this branch. The
clearest remaining unit of work is **W5a** — reconcile the rotted
architecture-guard test against the consolidation and wire it into the
`drift` job. After that, deflake `lib-staged-snapshot.test` (W5) and
confirm `check-resupply-migration-prefix.sh.test` green on a runner,
then wire both in. W3 is worth doing only if a CI-duration measurement
shows the double SPA build is on the critical path. W6 + W7 are
quality-of-life and can ride along with any other DX change.
