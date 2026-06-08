# Railway deployment reference

The canonical, living reference for **how PennFit builds and runs on
Railway**, and how to keep it that way. It complements, rather than
duplicates:

- [`README.md` → Hosting](../README.md#hosting) — the one-paragraph "what
  it deploys on."
- [`docs/runbooks/production-launch.md`](./runbooks/production-launch.md) —
  the first-launch _procedure_ (secrets → preflight → migrate → bootstrap →
  smoke-test).
- [`docs/railway-hosting-review-2026-05-29.md`](./railway-hosting-review-2026-05-29.md)
  — the point-in-time fitness _audit_ (findings R1–R6) that hardened this
  config.
- The `pennfit-deploy` skill (`.claude/skills/pennfit-deploy`) — the
  agent-facing checklist of the same invariants.

**Deploy target:** Railway, builder **Railpack** — there is no
`Dockerfile`, `nixpacks.toml`, or `railway.toml`. Production is the
`main`-branch deploy on `pennfit.up.railway.app` (or the bound custom
domain at `pennpaps.com`). Config-as-code lives in
[`railway.json`](../railway.json) at the repo root; values defined there
override the Railway dashboard.

> **Last verified end-to-end: 2026-06-07.** `railway.json` validated against
> the live Railway schema; the exact deploy `buildCommand` run on Node 24
> with `NODE_ENV=production` (both artifacts produced, exit 0);
> `verify:deploy` against production returned **3/3 passing**
> (`/resupply-api/healthz` and `/resupply-api/shop/products` serve JSON, `/`
> serves the SPA). The same build is re-checked on every PR by the
> `railway-build` CI job — see [Verifying a deploy](#verifying-a-deploy).

## One service, one process

Railway runs a **single** service for the whole app. The one Express
process started by `railway.json`'s `startCommand` serves all of:

- the storefront + fitter SPA (static, from `artifacts/cpap-fitter/dist/public/`),
- the admin console SPA (`/admin/*`),
- the public / storefront API (`/api/*`),
- the resupply admin + voice API (`/resupply-api/*`), and
- the in-process `pg-boss` worker (reminder scans + PHI attachment sweep).

There is no separate worker/web split and no separate static host. That
single-process shape is why a domain accidentally bound to a static-only
host produces the "SPA loads but every API call 404s" failure described
under [Verifying a deploy](#verifying-a-deploy).

## How Railway builds & runs the repo

Railpack auto-detects the pnpm workspace from `pnpm-workspace.yaml` and the
root `package.json` (`packageManager` + `engines.node`), then runs the
phases below. `railway.json` overrides the relevant defaults:

| Phase           | What runs                                                                                                       | Source                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Install**     | `pnpm install` (Corepack pins `pnpm@11.5.2` from `packageManager`)                                              | Railpack default                      |
| **Build**       | `pnpm -r --workspace-concurrency=1 --if-present run build`                                                      | `build.buildCommand`                  |
| **Pre-deploy**  | `node lib/resupply-db/scripts/deploy-migrate.mjs` (gates the deploy; **no-op unless `RUN_DB_MIGRATIONS=true`**) | `deploy.preDeployCommand`             |
| **Start**       | `node --enable-source-maps artifacts/resupply-api/dist/index.mjs`                                               | `deploy.startCommand`                 |
| **Health gate** | `GET /resupply-api/healthz` must return `200` within 90 s before traffic shifts to the new release              | `deploy.healthcheckPath` / `…Timeout` |

The build produces exactly the two artifacts the start command and the SPA
route depend on:

- `artifacts/resupply-api/dist/index.mjs` — the esbuild bundle the
  `startCommand` runs (emitted by `artifacts/resupply-api/build.mjs`:
  `outdir: dist`, `.js` → `.mjs`). Native/large deps (`argon2`, `pg`,
  `twilio`, `stripe`, `*.node`, …) are externalized and resolved from
  `node_modules` at runtime.
- `artifacts/cpap-fitter/dist/public/index.html` — the SPA shell. `app.ts`
  **throws at boot in production** if it's missing, so a broken SPA build
  can't silently ship.

> **Why the buildCommand skips the typecheck.** The root `build` script is
> `typecheck && build`, but `railway.json` deliberately runs only the
> recursive artifact build, serialized with `--workspace-concurrency=1`. The
> `tsc --build` across 23 projects is the heaviest memory consumer and was
> OOM-ing Railway's build container while GitHub CI stayed green;
> esbuild/Vite bundle the libs **from source** and never consume the `tsc`
> output, and CI's `lint-typecheck` job already gates types. See hosting
> review **R6**. Keep `railway.json`'s `buildCommand` and the `railway-build`
> CI job in sync.

## `railway.json`, field by field

Every field below is valid against the live schema
(`https://railway.com/railway.schema.json`) and is set deliberately:

| Field                            | Value                                                             | Why                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build.builder`                  | `RAILPACK`                                                        | Railpack auto-detects pnpm + Node; no Dockerfile/nixpacks to maintain.                                                                               |
| `build.buildCommand`             | `pnpm -r --workspace-concurrency=1 --if-present run build`        | Builds both artifacts, serialized, **without** the OOM-prone typecheck (R6).                                                                         |
| `build.watchPatterns`            | source dirs + key root config files                               | Scopes which path changes trigger a rebuild (`artifacts/**`, `lib/**`, the root manifests, `tsconfig*`, `railway.json`).                             |
| `deploy.preDeployCommand`        | `node lib/resupply-db/scripts/deploy-migrate.mjs`                 | Runs the migrator once per deploy **and gates on success** (a bad migration keeps the previous release live). No-op unless `RUN_DB_MIGRATIONS=true`. |
| `deploy.startCommand`            | `node --enable-source-maps artifacts/resupply-api/dist/index.mjs` | **Direct `node`, not `pnpm start`** so Node is PID 1 and SIGTERM reaches the graceful-shutdown handler (D3). Source maps make stack traces readable. |
| `deploy.healthcheckPath`         | `/resupply-api/healthz`                                           | **Liveness only — never `/readyz`** (D2). Touches no dependency, so a DB/worker hiccup can't blackhole the whole site behind the health gate.        |
| `deploy.healthcheckTimeout`      | `90`                                                              | Seconds Railway waits for the first `200` before failing the deploy.                                                                                 |
| `deploy.drainingSeconds`         | `30`                                                              | Grace before SIGKILL on rollover. The app's shutdown budget is 25 s (`TOTAL_BUDGET_MS`), so it always exits cleanly first (D4).                      |
| `deploy.restartPolicyType`       | `ON_FAILURE`                                                      | Restart a crashed process, but don't mask a clean exit.                                                                                              |
| `deploy.restartPolicyMaxRetries` | `10`                                                              | Bounded crash-loop retries before the deploy is marked failed.                                                                                       |

> **Schema gotcha.** Railway's prose docs summarize `preDeployCommand` as an
> "array" and `drainingSeconds`/`overlapSeconds` as "string". The
> _authoritative JSON schema_ is more permissive: `preDeployCommand` accepts
> `string | array(≤1) | null` and `drainingSeconds` accepts `number(≥0) |
null` — which is exactly the string + number forms used here. Don't
> "fix" these to match the prose summary.

## The boot contract — invariants that each map to a real outage

These live in `artifacts/resupply-api/src/index.ts` (and `src/app.ts`) and
are correctness, not style. Breaking any one has historically taken the site
down. The `pennfit-deploy` skill is the short version.

- **D1 — HTTP binds first; the worker starts in the background.** The
  listener binds, _then_ `scheduleWorkerStart()` retries pg-boss with
  backoff. A worker/DB failure must degrade to "background jobs paused,"
  never `process.exit`. The static storefront and the Stripe-less shop
  catalog need neither the worker nor the DB.
- **D2 — Health check is liveness (`/resupply-api/healthz`), never
  `/readyz`.** `/readyz` reports DB + worker readiness and is a
  monitoring/alerting signal, not a deploy gate. Pointing the health check at
  `/readyz` blackholes every path (including the static SPA) behind one
  failing dependency.
- **D3 — Start runs `node` directly, not `pnpm start`.** `pnpm` as PID 1
  swallows SIGTERM on every rollover, so graceful shutdown never fires and
  in-flight requests / jobs are SIGKILLed.
- **D4 — Graceful shutdown stays inside Railway's grace window.** Drain HTTP
  then stop pg-boss under a shared 25 s deadline (with 5 s reserved for the
  worker), comfortably under `drainingSeconds: 30`.
- **D5 — Bind dual-stack `::`.** One bind serves Railway's IPv4 public
  network and IPv6-only private network. Don't switch to `0.0.0.0`.

## Node & pnpm versions

Railpack resolves the **Node** version by priority:
`RAILPACK_NODE_VERSION` → `engines.node` → `.nvmrc` → `.node-version` →
`mise`/`.tool-versions` → its default (Node 22). In this repo:

- `engines.node` = `"24.x"` (root `package.json`) → resolves to the latest
  Node 24 via Railpack/mise.
- `.nvmrc` and `.node-version` both = `24` — consistent secondary signals
  (also used by `nvm`/`fnm`/`asdf` for local dev).

**Recommended operator pin:** set **`RAILPACK_NODE_VERSION=24`** in Railway
→ service → Variables. It outranks `engines.node` and is the only fully
authoritative pin, removing any chance of Railpack falling back to its
default major. Confirm the resolved Node major in the next Railway **build
log**. (This is optional — production is live and green on `24.x` — and it's
the one remaining item from hosting review **R2**. It's an environment
variable, not a repo file, so it can't be committed.)

**pnpm** is pinned to `pnpm@11.5.2` via the root `packageManager` field;
Corepack installs that exact version during the install phase.

## Required environment at boot

`assertRequiredEnv()` (`artifacts/resupply-api/src/lib/env-check.ts`) fails
fast with **one** error listing every missing variable. The required set is:
`PORT` (Railway-injected), `DATABASE_URL`, `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, `RESUPPLY_LINK_HMAC_KEY`,
`SUPABASE_STORAGE_BUCKET_PRIVATE`, and **`RESUPPLY_ALLOWED_ORIGINS` _or_
`RAILWAY_PUBLIC_DOMAIN`** (in `NODE_ENV=production` the API throws at boot if
both CORS vars are empty; Railway auto-populates `RAILWAY_PUBLIC_DOMAIN`).

Optional vendor keys (Stripe, Twilio, SendGrid, OpenAI/Anthropic/
ElevenLabs/Deepgram, object storage) **degrade gracefully** when unset — a
missing vendor key must never break a deploy.

The full table — required + every optional/feature-gated var and where it's
read — is in [`README.md`](../README.md#environment-variables),
[`.env.example`](../.env.example), and (for first launch, with production
values) [production-launch.md §2](./runbooks/production-launch.md#2-set-every-production-secret-5-min).

## Verifying a deploy

**Before** — validate env _shape_ (exits non-zero on any FAIL, so it can
gate a deploy):

```bash
pnpm --filter @workspace/scripts preflight:prod
```

Checks sk_live vs sk_test, base64 round-trip on HMAC keys, HTTPS-only public
URLs, `.env.example` placeholders, and the `STRIPE_WEBHOOK_SECRET` alias
confusion. It does **not** make live calls — a correctly-shaped but revoked
credential still passes.

**After** — confirm the API (not just the SPA) is actually routed:

```bash
pnpm --filter @workspace/scripts verify:deploy -- https://<host>
```

It asserts `/resupply-api/healthz` and `/resupply-api/shop/products` return
**JSON** (not the SPA HTML history-fallback) and that `/` serves the SPA. A
**404 for a JSON request** means the domain is bound to a static/SPA-only
host with no live `resupply-api` process behind `/resupply-api/*` — the
"shop shows Failed to load products (404)" / chatbot-down failure. Fix by
binding the domain to the single Express service. A `503` is reported as a
warning ("reachable but degraded"), not a routing failure.

**Continuously** — the `railway-build` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the _exact_
`railway.json` `buildCommand` on Node 24 + `NODE_ENV=production` with a
frozen install on every PR, and asserts both deploy artifacts exist. Nothing
else in CI exercises the production esbuild bundle, so this is the guard that
keeps a broken deploy build from staying green.

## Migrations on deploy

The `preDeployCommand` is **opt-in**: it runs the migrator only when
`RUN_DB_MIGRATIONS=true`, and otherwise exits 0 (a no-op). When enabled it
runs once per deploy, before the new release goes live, and **gates the
deploy on success** — a migration error keeps the previous release running
rather than taking the site down. Production has no migration ledger yet, so
it must be **baselined once** before the flag is enabled; see
[`docs/runbooks/adopt-migration-ledger.md`](./runbooks/adopt-migration-ledger.md)
and the `pennfit-migrations` skill.

## What is intentionally absent

- **No `Dockerfile` / `nixpacks.toml` / `railway.toml`.** Railpack is the
  builder; adding any of these would change how the app is built.
- **`.dockerignore` is not consulted** (the builder is Railpack, not
  Dockerfile). It's harmless. If build-context trimming is ever wanted,
  Railpack honors `.railwayignore`.
- **No `start` script at the repo root.** The start command is set
  explicitly in `railway.json`; Railpack's start inference is unused.

## See also

- [`railway.json`](../railway.json) — the config itself.
- [`artifacts/resupply-api/src/index.ts`](../artifacts/resupply-api/src/index.ts) — boot, shutdown, worker retry.
- [`scripts/src/verify-deploy.ts`](../scripts/src/verify-deploy.ts) · [`scripts/src/preflight-prod-env.ts`](../scripts/src/preflight-prod-env.ts) — the probes above.
- [`docs/runbooks/chatbot-down-api-not-served-2026-05-29.md`](./runbooks/chatbot-down-api-not-served-2026-05-29.md) · [`docs/runbooks/worker-recovery.md`](./runbooks/worker-recovery.md) — incident runbooks.
- [`CLAUDE.md`](../CLAUDE.md) — the deploy invariants in the agent guide.
