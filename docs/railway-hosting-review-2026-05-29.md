# Railway hosting review — 2026-05-29

Scope: research Railway.com hosting and review the whole repo for fitness to
run on Railway. PennFit already deploys to Railway (production is the
`main`-branch deploy on `pennfit.up.railway.app`); this is a fitness/robustness
audit, not a first-time setup.

**Verdict: the repo is well-suited to Railway and the deploy config is
carefully built.** No blocking problems. One real (silent) build-time risk and
a few defensive recommendations are below.

## How Railway builds & runs this repo

- **Builder:** Railpack (`railway.json` → `build.builder = "RAILPACK"`). No
  `Dockerfile` / `nixpacks.toml` (confirmed absent). Railpack auto-detects the
  pnpm workspace from `pnpm-workspace.yaml` and `packageManager`/`engines` in
  the root `package.json`.
- **Install:** Railpack runs `pnpm install` (corepack pins `pnpm@11.4.0` from
  the root `packageManager` field).
- **Build:** `railway.json` → `build.buildCommand = "pnpm run build"` →
  root `package.json` `build` = `pnpm run typecheck && pnpm -r --if-present run build`.
  That builds **both** deployable artifacts:
  - `artifacts/resupply-api` → `node ./build.mjs` (esbuild) → `dist/index.mjs`
  - `artifacts/cpap-fitter` → `vite build` → `dist/public/`
- **Start (one command, one service):**
  `node --enable-source-maps artifacts/resupply-api/dist/index.mjs`. This single
  Express process serves `/api/*`, `/resupply-api/*`, AND the static SPA, and
  hosts the in-process pg-boss worker.
- **Health check (deploy gate):** `/resupply-api/healthz` (liveness, no
  dependencies), `healthcheckTimeout: 90`.

Railway config-as-code reference confirms the fields used here are all valid:
`builder`, `buildCommand`, `watchPatterns`, `startCommand`, `healthcheckPath`,
`healthcheckTimeout`, `drainingSeconds`, `restartPolicyType`,
`restartPolicyMaxRetries`. (`preDeployCommand` also exists — see Migrations.)

## What is correct (verified)

1. **Start command runs Node directly, not `pnpm start`** (`railway.json:20`).
   This is essential: Node is PID 1 so SIGTERM reaches the graceful-shutdown
   handler. Running via pnpm would make pnpm PID 1 and swallow SIGTERM on every
   deploy rollover. Matches CLAUDE.md's hard rule.
2. **Build output path matches the start command.** `build.mjs` emits ESM to
   `dist/index.mjs` (`artifacts/resupply-api/build.mjs:14,22-23`); start command
   points at exactly that file.
3. **Native deps are externalized and resolved from `node_modules` at runtime**
   (`build.mjs:34-108`: `argon2`, `pg`, `twilio`, `stripe`, `*.node`, …). pnpm
   places them under `artifacts/resupply-api/node_modules` (→ store), so the
   bundle resolves them upward at runtime. Works with Railway cwd = repo root.
4. **PORT handling** (`src/index.ts:37-49`): reads `process.env.PORT`, throws a
   clear error if missing/invalid. Railway injects `PORT`.
5. **Host binding is dual-stack.** `httpServer.listen(port, cb)` with host
   omitted (`src/index.ts:383`) makes Node bind `::` with dual-stack, which
   serves Railway **public** networking (IPv4 `0.0.0.0`) and **private**
   networking (IPv6 `::`) simultaneously. Correct; optionally make `"::"`
   explicit (see R3).
6. **Graceful shutdown** (`src/index.ts:238-287`): SIGTERM/SIGINT → drain HTTP
   (budget) → close WS → stop pg-boss → flush logs → exit. Total budget 25s,
   under `drainingSeconds: 30`, so we always exit cleanly before SIGKILL.
7. **HTTP serving decoupled from the worker** (`src/index.ts:368-399`): the
   listener binds FIRST, then `scheduleWorkerStart()` retries pg-boss in the
   background with backoff; a worker/DB failure NEVER `process.exit`s. A DB
   hiccup degrades to "background jobs paused", not a dark site. Matches
   CLAUDE.md's service-boot contract.
8. **Health endpoints** (`src/routes/health.ts`, `src/lib/readiness.ts`):
   `/resupply-api/healthz` returns `{status:"ok"}` with no DB call (correct
   deploy gate); `/resupply-api/readyz` probes Supabase (`feature_flags` HEAD)
   + `isWorkerReady()`, 503 on failure — a monitoring signal, not the gate.
9. **`trust proxy = 1`** (`src/app.ts:42`): correct for Railway's single edge
   proxy so `req.ip` is honest for rate limiting and audit IP capture.
10. **CORS** (`src/app.ts:67-94`): uses `RESUPPLY_ALLOWED_ORIGINS` **or**
    Railway's auto-populated `RAILWAY_PUBLIC_DOMAIN`; in production it **fails
    closed** (throws at boot) if both are empty.
11. **SPA serving is cwd-independent and fails loud in prod** (`src/app.ts:398-460`):
    `SPA_DIST` is resolved from `import.meta.url` (not cwd), so it's robust to
    Railway's cwd = repo root; in production the app **throws at boot** if
    `cpap-fitter/dist/public/index.html` is missing — a missing SPA build can't
    silently ship.
12. **Boot env validation** (`src/lib/env-check.ts`): `assertRequiredEnv()` runs
    before side-effecting imports and lists *every* missing required var at once
    (`PORT`, `DATABASE_URL`, Supabase, link HMAC). Feature-gated vendors degrade
    gracefully — preview deploys don't need every credential.
13. **Ephemeral filesystem respected:** runtime uploads (POD photos, Rx PDFs,
    MMS) go to Supabase Storage, not local disk. No runtime path depends on a
    persistent local FS. (Office Ally only writes to a local outbox in stub
    mode.)
14. **Migrations are intentionally NOT auto-run on deploy** (see below).

## Migrations — by design, not a gap

`docs/runbooks/production-launch.md` §3 states migrations are run manually via
`pnpm --filter @workspace/resupply-db migrate` (uses `DATABASE_URL`) and are an
"operator-gated step — **not** wired into the Railway build/deploy so a bad
migration can't auto-roll to prod." So the absence of a `preDeployCommand` in
`railway.json` is deliberate. If the team ever wants gated auto-migration,
Railway's `deploy.preDeployCommand` is the supported hook — but that is an
explicit owner decision, not a defect.

## Risks & recommendations

### R1 — Build-time model download fails OPEN — ✅ FIXED in this PR

> **Fixed:** `setup-mediapipe.mjs` now runs in **strict mode on any production
> build** (`npm_lifecycle_event` = `prebuild`/`build`, any `RAILWAY_*` var, `CI`,
> or `NODE_ENV=production`): a missing / un-downloadable model now **fails the
> build** instead of shipping silently broken. `SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1`
> still opts out for intentional offline / preview builds. As a runtime net,
> `app.ts` logs a loud `face_model_missing` error at boot if the model isn't in
> the served build. **Residual operator step:** ensure the Railway build can
> reach `storage.googleapis.com` (the build now fails loudly if it can't — set
> `SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1` to bypass deliberately), or vendor the model
> to remove the build-time egress entirely.

_Original finding:_
`artifacts/cpap-fitter/scripts/setup-mediapipe.mjs` runs as `prebuild` during
the Railway build. It copies the MediaPipe **WASM** from `node_modules` (no
network) but **downloads the `face_landmarker.task` model from
`storage.googleapis.com`** at build time. The model is **gitignored / not
committed** (`artifacts/cpap-fitter/.gitignore:2`). On download failure the
script logs an error but **intentionally does not exit non-zero**
(`setup-mediapipe.mjs:120-129`) — so the build **succeeds** and the face-scan
feature ships **silently broken**. (Also: the `sha256` in `MODELS` is a
placeholder and is not actually verified.)

Implications / actions:
- Ensure the Railway **build** environment's network policy allows outbound
  `storage.googleapis.com`. If egress is restricted, the model won't vendor.
- Because it fails open, add monitoring or a post-deploy check that
  `dist/public/vendor/mediapipe/face_landmarker.task` exists.
- For determinism, either commit the model asset (it is currently gitignored)
  or make the download hard-fail **in CI only** (keeping deploy resilient).
  Both are owner tradeoffs (binary-in-git vs. deploy resilience) — flagged, not
  changed here.

### R2 — Pin the Node version explicitly — ✅ FIXED in this PR

> **Fixed:** `engines.node` pinned `">=24"` → `"24.x"` (bounded major), plus a
> `.node-version` (`24`). **Residual operator step (recommended):** set
> `RAILPACK_NODE_VERSION=24` in Railway → Variables — it outranks `engines.node`
> and is the only fully authoritative pin. Confirm the resolved Node major in
> the next Railway build log.

_Original finding:_
Root `engines.node = ">=24"`; Railpack's documented default is **22**. Multiple
Railway community reports describe Railpack **silently falling back to its
default (or even Node 18)** when the requested major isn't in its package
catalog or a range can't be satisfied — so a range like `">=24"` is not a
guaranteed pin. In practice this is **most likely fine today** (Node 24 reached
LTS in late 2025 and production is live), but it is worth making deterministic.

Important caveat on the fix: Railpack's resolution **priority** is
`RAILPACK_NODE_VERSION` → `engines.node` → `.nvmrc` → `.node-version` → mise →
default. Because `engines.node` is consulted **before** `.node-version`, the
`.node-version` file this review adds only helps if Railpack falls through the
`engines` range without resolving it — it may be ignored entirely. The only
fully reliable override is therefore:
- **Set `RAILPACK_NODE_VERSION=24` in Railway → Variables** (highest priority),
  and/or pin `engines.node` to a concrete value (e.g. `24.x`).
- Confirm the actual Node major in the next Railway **build log** (Railpack
  prints the resolved version) and in `/resupply-api`'s boot logs.
- The `.node-version` (`24`) added here is a harmless secondary signal (also
  used by nvm/fnm for local dev); it is **not** a substitute for the above.

### R3 — Make host binding explicit — ✅ FIXED in this PR
`src/index.ts` now binds `"::"` explicitly (dual-stack: serves Railway IPv4
public **and** IPv6 private networking) instead of relying on Node's implicit
default. Previously it relied on Node's implicit `::` dual-stack bind — correct,
but now unambiguous and robust to a future Node default change.

### R4 — Unused drizzle deps (cleanup, not Railway)
`lib/resupply-db/package.json:16-18` still lists `drizzle-orm`/`-kit`/`-zod`
though CLAUDE.md says Drizzle was fully retired (migrations apply via raw `pg`).
Dead install weight; out of scope for this review.

### R5 — `.dockerignore` not used by Railpack (info)
A `.dockerignore` exists but the builder is `RAILPACK` (not `DOCKERFILE`), so it
isn't consulted. Harmless. If build-context trimming is ever wanted, Railpack
honors `.railwayignore`.

## Bottom line
Config and app are Railway-appropriate and reflect real production hardening
(single-process API+SPA+worker, liveness-only health gate, decoupled worker,
trust-proxy, fail-closed CORS, graceful SIGTERM). **R1, R2, and R3 are now
addressed in this PR** (strict model build + runtime guard; Node pinned to
`24.x` + `.node-version`; explicit `::` bind). The only remaining items are
operator-side: set `RAILPACK_NODE_VERSION=24` in Railway → Variables, and
confirm the build can reach `storage.googleapis.com` (or vendor the model).
