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
| W5  | Shell-script test files (`*.sh.test`) execute nowhere         | MEDIUM   | ✅ all 4 wired in                |
| W5a | The architecture-guard test had rotted (stale `resupply-worker`) | MEDIUM | ✅ fixed (fixtures repointed)    |
| W5b | The architecture gate was a **silent no-op in CI** (no `rg`)   | HIGH     | ✅ fixed (install rg + hard-fail) |
| W6  | No single "run what CI runs" local command                   | LOW      | ✅ fixed (`pnpm verify`)         |
| W7  | Hooks not auto-installed on fresh clone (only post-merge)     | LOW      | ✅ fixed (documented setup step) |
| W8  | `pnpm typecheck` runs in `build`, then again in CI standalone | INFO     | open — note                     |

Shipped on this branch: W1, W2 (mechanical CI DRY + caching), W4 (the
dev-server e2e job, soft-gated), W5 (all four dormant/under-run guard-test
harnesses now run in CI), and **W5a** (the architecture-guard test had
silently rotted against the May-2026 artifact consolidation — its worker
fixtures are repointed to the real location), **W5b** (the architecture
gate was a silent no-op in CI because the runner had no ripgrep — now
fixed and hardened to fail loudly), plus W6 (`pnpm verify`) and W7 (a
documented hook-install step). Investigating W5 was itself the payoff:
running the dormant tests is how the W5a rot, the **W5b vacuous-pass**,
and a self-inflicted bug in the snapshot-lib test surfaced at all — W5b
in particular is a guard that had been green for months while enforcing
nothing. The only items left **open** are W3 (optional — measure first)
and W8 (informational, no action).

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

### [MEDIUM] W5 — Shell-script guard tests execute nowhere → **3 of 4 wired in**

`scripts/` ships fixture-driven test files for its bash guards. Each
guard script exposes a `--self-test` flag that `exec`s its sibling
`*.sh.test` (builds a synthetic tree, plants known violations, asserts
the checker catches them, then asserts a clean tree passes).

| Test file (`--self-test`)                  | Size  | Tests its sibling                    | Status before / after               |
| ------------------------------------------ | ----- | ------------------------------------ | ----------------------------------- |
| `check-admin-route-gates.sh.test`          | 5.7 KB| `check-admin-route-gates.sh`         | already ran via `--self-test`       |
| `check-resupply-architecture.sh.test`      | 35 KB | `check-resupply-architecture.sh`     | dormant + rotted → ✅ fixed & wired |
| `check-resupply-migration-prefix.sh.test`  | 6.3 KB| `check-resupply-migration-prefix.sh` | dormant → ✅ wired                  |
| `git-hooks/lib-staged-snapshot.test`       | 11 KB | `lib-staged-snapshot.sh`             | dormant + buggy → ✅ fixed & wired  |

**Correction to the first pass of this audit:** the admin-gate harness
was _not_ dormant — the `drift` job already ran
`check-admin-route-gates.sh --self-test`, and `--self-test` execs the
`.sh.test`. The genuinely-dormant harnesses were the **architecture**
and **migration-prefix** ones: their `drift` steps ran only the real
checker (`check-resupply-architecture.sh` /
`check-resupply-migration-prefix.sh`), never `--self-test`. So the
fixture coverage for the repo's most safety-critical guard — the one
that protects the hexagonal dependency rules — was running nowhere.

**Fix (this branch).** Added four steps to the `drift` job:
`check-resupply-architecture.sh --self-test`,
`check-resupply-migration-prefix.sh --self-test`, and a direct
`bash scripts/git-hooks/lib-staged-snapshot.test`. All pass locally
(the architecture one after the W5a repoint below; the migration-prefix
one runs clean on a stock runner — its fixture commits were only
intercepted by this sandbox's commit-signing config; the
staged-snapshot one after the scenario-9 fix below).

- **`git-hooks/lib-staged-snapshot.test`** failed scenario 9
  deterministically — but the bug was in the **test**, not the lib. The
  scenario redirected the wrapper's stderr to `$WORK/hint.log`, a file
  **inside the repo working tree**. Scenario 9 isn't in a complex git
  state, so the wrapper does full isolation: it archives every untracked
  file (including the empty `hint.log` it was about to write to), runs
  the command, fires the "recovery dir:" breadcrumb into `hint.log`, then
  **restores the archived empty version on the way out** — clobbering the
  breadcrumb the test then grepped for. (Scenario 4 gets away with a
  `$WORK/warn.log` only because its mid-merge state makes the wrapper
  skip isolation.) The production lib was behaving **perfectly** — it
  correctly snapshots and restores untracked files, including the test's
  own stderr sink. Fix: move the sink to `mktemp` (`$TMPDIR`, outside the
  swept tree). Now passes 15/15 across both the default and this
  environment's `core.checkstat=minimal` git config, with **zero change
  to the lib**.

### [MEDIUM] W5a — The architecture-guard test had rotted → **fixed**

`check-resupply-architecture.sh.test` — the negative-test harness for
the repo's **primary architecture invariant checker** — failed on the
current `main`. It planted fixtures under `artifacts/resupply-worker/src`
and asserted the checker flagged them, but `resupply-worker` was **folded
into `resupply-api` during the May-2026 consolidations** (the worker now
lives at `artifacts/resupply-api/src/worker/`). The checker's per-rule
directory lists were updated to drop the standalone `resupply-worker`
path; the test was not — so ~7 `resupply-worker` fixture cases (across
Rules 6, 7, 8) asserted against a directory the checker no longer scans.
The failures cascaded (fixing the Rule 6 case exposed the Rule 7 case,
…). This is the exact danger dormant tests create: **the test for the
architecture guard no longer matched the guard, so the guard could
regress with nothing to catch it.**

**Fix.** Repointed all 17 `artifacts/resupply-worker/src` fixture paths
to `artifacts/resupply-api/src/worker` — the real post-consolidation
worker location, which Rules 6/7/8 reach via their recursive
`artifacts/resupply-api/src` scan. This preserves every case's intent
("the worker tree must not import the storefront UI client / `pg` /
write `audit_log` directly") while pointing at a path the checker
actually covers, so the test now also **proves the worker tree stayed
covered after the fold-in**. The full harness passes (exit 0), and the
two `--self-test` steps above wire it into CI. No change was made to the
enforcement script itself.

A note on what was deliberately _not_ changed: the `resupply-dashboard`
fixture cases (and the checker's `artifacts/resupply-dashboard/src`
enumeration entries) were left as-is. Unlike the worker cases they
**pass** — they create a fixture dir and verify the checker still
flags violations there, which functions as a forward-looking tripwire
if a `resupply-dashboard` artifact is ever re-added. Removing them would
have meant editing the enforcement script for no functional gain, so
that cleanup (if desired) is left as a separate, optional call.

### [HIGH] W5b — The architecture gate was a silent no-op in CI (no ripgrep)

Wiring the architecture checker's self-test into CI (W5) immediately
failed — with `rg: command not found`. `check-resupply-architecture.sh`
implements **every** rule as a `ripgrep` query, and the `ubuntu-latest`
runner image **does not ship ripgrep**. The consequence is the
important part: the `drift` job's existing "Architecture drift" step
(the real scan, running since this workflow was written) was **passing
vacuously** — with `rg` absent, each query errored to stderr, matched
nothing, and the checker printed "Resupply architecture check passed."
So the repo's primary architecture invariant (the hexagonal dependency
rules: no `pg` outside resupply-db, no vendor SDKs in pure libs, no
direct `audit_log` writes, …) **was not actually enforced on CI** — a
violation could merge clean. The self-test is what exposed it, because
it asserts that planted violations are _detected_, not merely that the
checker exits 0.

**Fix, two parts:**

1. **Install ripgrep** in the `drift` job (`apt-get install -y ripgrep`)
   before the architecture steps, so the real scan and the self-test
   both actually run their queries.
2. **Hard-fail the checker when `rg` is absent** (a `command -v rg`
   guard at the top that exits non-zero with an install hint) so the
   gate can never again degrade into a silent rubber stamp on a runner
   or developer machine without ripgrep — the failure mode that hid
   this for as long as the workflow has existed.

This is the highest-impact finding of the audit: a guard that had been
green for months while enforcing nothing. It is exactly the class of
problem the "make the dormant tests actually run" work (W5) exists to
catch.

### [LOW] W6 — No single "run exactly what CI runs" local command → **fixed**

A contributor wanting to pre-flight a PR locally had to know to run
`pnpm lint:resupply`, `pnpm typecheck`, `pnpm test`,
`scripts/check-resupply-architecture.sh`, and
`scripts/check-admin-route-gates.sh` by hand, in the right order. The
pre-commit hook runs a _subset_ (arch + migration-prefix + ts-syntax)
but not lint/typecheck/test.

**Fix.** Added a root `pnpm verify` script:

```json
"verify": "pnpm run lint:resupply && pnpm run typecheck && scripts/check-resupply-architecture.sh && scripts/check-admin-route-gates.sh && pnpm run test"
```

It mirrors the **infrastructure-free** gating CI jobs (the
`lint-typecheck`, `drift`, and `test` jobs) in one command. The
DB-migration replay and the Playwright smoke/a11y/e2e jobs need Postgres
/ browsers and are intentionally excluded — they belong to CI, not a
quick local pre-flight. The guard-script `--self-test` harnesses are
also out of `verify` (they matter when editing the checkers themselves,
not a feature change); CI's `drift` job covers them. Pure convenience;
no behavior change.

### [LOW] W7 — Git hooks only auto-install on `post-merge` → **fixed (documented)**

`scripts/install-hooks.sh` is invoked from `scripts/post-merge.sh`, so a
contributor picks up the hooks only _after their first merge_. A fresh
clone that hasn't merged yet commits with no architecture/migration/
ts-syntax guard.

**Fix.** Added `bash scripts/install-hooks.sh` as an explicit step 1b in
the README "Getting started" block (it was previously only mentioned in
passing). Chose documentation over a `package.json` `"prepare"` hook on
purpose: the installer's own header lists "no `prepare` script" as a
deliberate design property (it's invoked from `post-merge` and is
idempotent), so wiring a `prepare` script would override an explicit
authoring decision and make the hook re-run on every `pnpm install` —
including in CI, where it's pure waste. The documented step closes the
fresh-clone gap without that cost. (If the team later decides the
auto-install convenience is worth it, the `prepare` route remains a
one-line change.)

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

W1, W2, W4, W5, W5a, W6, and W7 are all on this branch — every guard-test
harness now runs in CI, and the local pre-flight + fresh-clone setup gaps
are closed. The only remaining item that could be acted on is **W3**
(build the SPA once and share it via artifact instead of rebuilding it in
both the `a11y` and `smoke` jobs) — and that's worth doing only if a
CI-duration measurement shows the double build is actually on the
critical path. W8 is informational (no action).
