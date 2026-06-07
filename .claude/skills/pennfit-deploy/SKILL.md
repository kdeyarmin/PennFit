---
name: pennfit-deploy
description: PennFit's Railway deploy + service-boot contract — the invariants that, when broken, have blackholed the entire site behind one dependency. Covers HTTP-before-worker decoupling, the liveness health check (`/resupply-api/healthz`, never `/readyz`), the direct-`node` start command (SIGTERM/graceful-shutdown), dual-stack bind, required boot env (incl. CORS-or-throw), `preflight:prod` before a deploy, and `verify:deploy` after. Use when editing `artifacts/resupply-api/src/index.ts` (boot/shutdown/worker start), `railway.json`, health-check or `/readyz` code, CORS/boot-env handling, or verifying/diagnosing a deploy ("API 404s but SPA loads", "site down", "worker won't start").
---

# PennFit deploy & service-boot contract

Deploy target is **Railway** (Railpack auto-detects pnpm + Node from the
root `package.json`; config is `railway.json` at the repo root). The rules
below are correctness invariants — each one corresponds to a real outage.
See `docs/runbooks/chatbot-down-api-not-served-2026-05-29.md` and
`docs/railway-hosting-review-2026-05-29.md`.

## The boot contract — do not break

### D1 — HTTP binds FIRST; the worker starts in the background
`src/index.ts` binds the Express listener, **then** starts the in-process
pg-boss worker with retry/backoff. A worker/DB hiccup must degrade to
"background jobs paused", never take the public site down (the static
storefront + Stripe-less shop catalog need neither the worker nor the DB).
- **NEVER `process.exit` on worker-boot failure** (`src/worker/**`,
  `scheduleWorkerStart`). Binding the listener only after `startWorker()`
  resolved — and exiting on failure — is what took the whole site dark.

### D2 — Health check is liveness `/resupply-api/healthz`, NEVER `/readyz`
`railway.json` `healthcheckPath` must be `/resupply-api/healthz` (touches no
dependency). `/readyz` reports DB + worker readiness and is a
**monitoring/alerting** signal, **not** a deploy gate. Pointing the health
check at `/readyz` blackholes the entire site behind one failing dependency
(the chatbot-down incident: Railway's edge then 404s every path, including
the static SPA).

### D3 — Start command runs `node` directly, not `pnpm start`
`startCommand` is `node --enable-source-maps artifacts/resupply-api/dist/index.mjs`.
Running via `pnpm start` makes pnpm PID 1, which **silently swallows
SIGTERM** on every deploy rollover — the graceful-shutdown handler never
fires and in-flight requests / pg-boss jobs are SIGKILLed.

### D4 — Graceful shutdown stays within the orchestrator grace window
`shutdown()` drains HTTP then stops pg-boss under a shared
`TOTAL_BUDGET_MS = 25_000` deadline (with `WORKER_MIN_BUDGET_MS = 5_000`
reserved for the worker). Keep the total under Railway's 30s grace so we
abort cleanly before SIGKILL. Don't reintroduce independent per-phase
timeouts that can sum past the grace window.

### D5 — Bind dual-stack `::`
The listener binds host `::` so one bind serves Railway's IPv4 **public**
network and IPv6-only **private** network. Don't change it to `0.0.0.0`.

## Required boot env (API refuses to start if any is missing)

`assertRequiredEnv()` fails fast with one error listing **every** missing
variable:

| Variable | Notes |
| --- | --- |
| `PORT` | Injected by Railway. |
| `DATABASE_URL` | Migrator + a few legacy worker paths. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Runtime data path. Both `resupply` and `resupply_auth` must be in Supabase "Exposed schemas" or every query 503s. |
| `RESUPPLY_LINK_HMAC_KEY` | Signs short-lived patient links. |
| `RESUPPLY_ALLOWED_ORIGINS` **or** `RAILWAY_PUBLIC_DOMAIN` | CORS allowlist. In `NODE_ENV=production` the API **throws at boot if both are empty** (`src/app.ts`). Railway auto-populates `RAILWAY_PUBLIC_DOMAIN`. |
| `SUPABASE_STORAGE_BUCKET_PRIVATE` | Customer attachments bucket; the PHI sweep refuses to register without it. |

Optional vendor keys (Stripe, Twilio, SendGrid, OpenAI/Anthropic/ElevenLabs/
Deepgram, object storage) **degrade gracefully** when unset — a missing
vendor key must never break a deploy.

## Before a deploy — validate env shape

```bash
pnpm --filter @workspace/scripts preflight:prod
```
Validates every required var plus production-only shape checks (sk_live vs
sk_test, base64 round-trip on HMAC keys, HTTPS-only public URLs,
`.env.example` placeholder detection, the `STRIPE_WEBHOOK_SECRET` alias
confusion). Exits non-zero on any FAIL so it can gate a deploy.

DB migrations on deploy are **opt-in** via `RUN_DB_MIGRATIONS=true` and must
be baselined once first — see the **pennfit-migrations** skill and
`docs/runbooks/adopt-migration-ledger.md`.

## After a deploy — confirm the API is actually routed

Always run the post-deploy smoke test — a passing SPA does **not** prove the
API is mounted:

```bash
pnpm --filter @workspace/scripts verify:deploy -- https://<host>
```
It asserts `/resupply-api/healthz` and `/resupply-api/shop/products` return
**JSON** (not the SPA HTML history-fallback). A **404 for a JSON request**
means the production domain is bound to a host serving only the static SPA
with no live `resupply-api` process behind `/resupply-api/*` — the exact
"shop shows Failed to load products (404)" / chatbot-down failure. Fix by
binding the domain to the single Express service (`railway.json`
`startCommand`). A `503` is reported as a warning ("reachable but
degraded"), not a routing failure.

## Symptom → cause

| Symptom | Likely cause |
| --- | --- |
| Entire site (even storefront) 404s after deploy | Health check repointed at `/readyz`, or worker failure killed the process (D1/D2) |
| SPA loads but `/resupply-api/*` 404s for JSON | Domain bound to a SPA-only host; no API process behind it — run `verify:deploy` (it names the fix) |
| In-flight requests/jobs killed on every rollover | Started via `pnpm start`, not direct `node` — SIGTERM swallowed (D3) |
| API throws at boot in production | Missing required env, or both CORS vars empty (`src/app.ts`) |
| "Background jobs paused" but site up | Worker retrying in background (expected, fail-soft) — check `/readyz` and `worker_start_failed` logs |

## Don'ts (re-coupling regressions)

- Don't `process.exit` on worker-boot failure.
- Don't point `healthcheckPath` at `/readyz`.
- Don't wrap the start command in `pnpm`.
- Don't bind a single-stack host.
- Don't make the static storefront / public shop catalog depend on the
  worker or DB.

## Pointers

- `artifacts/resupply-api/src/index.ts` — boot, shutdown, worker retry.
- `railway.json` — build/start/health/preDeploy config.
- `scripts/src/verify-deploy.ts` — post-deploy routing probe.
- `scripts/src/preflight-prod-env.ts` — pre-deploy env validator.
- `docs/runbooks/worker-recovery.md` · `docs/runbooks/chatbot-down-api-not-served-2026-05-29.md`
  · `docs/runbooks/production-launch.md`.
