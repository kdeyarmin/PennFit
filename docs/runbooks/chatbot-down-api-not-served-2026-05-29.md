# Storefront chatbot down — production API not served (2026-05-29)

The customer-facing chatbot ("PennBot") errored for every message with
_"Something went wrong reaching the chat service … connection issue"_.

> ## ✅ RESOLVED 2026-05-29
> The chatbot (and the whole site's API) is live on `pennfit.up.railway.app`.
> **Actual root cause:** the Railway project had **two services** —
> `cpap-fitter` (running `vite preview`, a static SPA) and `resupply-api`
> (the consolidated Express server). The customer domain
> `pennfit.up.railway.app` was bound to **`cpap-fitter`**, so `/api/*`
> (including `/api/chat`) 404'd. The consolidated `resupply-api` was healthy
> the whole time but only reachable at `penn.up.railway.app`.
> **Fixes applied:** (1) created `resupply.feature_flags` so `/readyz` passes;
> (2) set `ANTHROPIC_API_KEY` on `resupply-api` + redeployed (bot answers for
> real); (3) moved `pennfit.up.railway.app` onto `resupply-api` by renaming
> service domains in place (`cpap-fitter`'s → `pennfit-legacy`, then
> `resupply-api`'s `penn` → `pennfit`). Verified: `/`=SPA 200,
> `/api/healthz`=JSON, `/readyz`=ready, `/api/chat`=real Claude reply.
> **Follow-ups:** ~~delete the orphaned `cpap-fitter` service~~ (done — service
> deleted 2026-05-29); reconcile the broader DB migration drift (some worker
> jobs still log `*_select_failed` against missing tables — full inventory +
> triage in [`docs/db-schema-drift-2026-05-29.md`](../db-schema-drift-2026-05-29.md)).

This runbook captures the root cause and the steps taken on **2026-05-29**.
The chatbot **code was healthy throughout** — the issue was deploy topology.

> For future incidents, use the checklist below as a **re-run procedure**.
> For the 2026-05-29 incident specifically, steps 1–6 were completed to restore service.

| # | Step | Where it runs | Status |
| - | ---- | ------------- | ------ |
| 1 | Create `resupply.feature_flags` (+ seed) in the prod DB | Supabase (PennPaps) | ✅ **Done 2026-05-29** (migration `0149`) |
| 2 | Verify `resupply` exposed to PostgREST + `service_role` grants | Supabase | ✅ **Verified 2026-05-29** (no action needed) |
| 3 | Set required env on the Railway service | Railway dashboard → Variables | ☐ Operator |
| 4 | Redeploy current `main`; confirm `/readyz` 200 & deploy promotes | Railway dashboard → Redeploy | ☐ Operator |
| 5 | Confirm the domain is bound to the consolidated service | Railway dashboard → Settings → Domains | ☐ Operator |
| 6 | Smoke-test the chatbot end to end | Your laptop / browser | ☐ Operator |

> **DB side is fully ready.** Everything Supabase-side that gates the
> healthcheck is done — the remaining steps (3–6) are all Railway dashboard
> actions plus setting an LLM key.

---

## Symptom

The chat widget shows the degraded fallback (`floating-contact-launcher.tsx`),
with the "connection issue" label and the **Try again / Talk to a person**
buttons. That path only fires when the client's request to `/api/chat`
**throws** — i.e. the endpoint returns a non-2xx that isn't 404/429/HTML,
or the request fails at the network layer.

## Root cause

Production at `pennfit.up.railway.app` is serving the **static cpap-fitter
SPA**, not the consolidated Express server that hosts both `/api/*` and the
SPA. Probes:

```bash
# Every API route returns the SPA's index.html (7075 bytes) or a bare 404,
# and none carry the app's X-Request-Id header → not the Express app.
curl -i  https://pennfit.up.railway.app/resupply-api/readyz   # 200 text/html (SPA shell)
curl -i  https://pennfit.up.railway.app/api/healthz           # 200 text/html (SPA shell)
curl -i -X POST https://pennfit.up.railway.app/api/chat \
     -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'
                                                              # 404, empty body
```

Why the real server never goes live:

1. The consolidated server is **fail-fast by design** — `start()` runs
   `startWorker()` (pg-boss) **before** `httpServer.listen()`
   (`artifacts/resupply-api/src/index.ts`), and the Railway healthcheck is
   `/resupply-api/readyz`.
2. `/readyz`'s DB probe issues a PostgREST query against
   **`resupply.feature_flags`** (`artifacts/resupply-api/src/lib/readiness.ts`).
3. The production Supabase DB (**PennPaps**, project `uppdjphagdildcgkvdsz`)
   was provisioned by 8 Supabase-native migrations, **not** the repo's
   migration system, and was **missing `resupply.feature_flags`** entirely
   (`drizzle.resupply_migrations` history schema is also absent; `auth.users`
   is empty).
4. Missing table → `/readyz` 503 → Railway marks the deploy unhealthy →
   it is **never promoted** → the previous static-SPA deploy stays live →
   `/api/chat` 404s → the widget errors.

The chatbot code itself was verified healthy: the server bundles cleanly,
the `/chat` route returns 200 for every internal path (offline / degraded /
success), and the system prompt is 76,692 chars (under the 80k cap).

## Remediation

### 1. Create `resupply.feature_flags` — ✅ done 2026-05-29

Applied repo migration `lib/resupply-db/drizzle/0149_feature_flags.sql`
(additive + idempotent) to the PennPaps Supabase project. Verify:

```sql
select key, enabled from resupply.feature_flags order by key;
-- expect 12 rows incl. storefront.chatbot = true
```

> Note: this is a **targeted** fix for the healthcheck blocker, not a full
> reconciliation. The production DB is broadly out of sync with the repo's
> migrations (e.g. no `drizzle.resupply_migrations`, `auth.users` empty,
> `resupply.masks` absent — the chatbot uses the static `maskCatalog.ts` so
> that one doesn't affect it). A separate migration-reconciliation effort
> is warranted; see `docs/migration-state-investigation-2026-05-08.md`.

### 2. Schema exposure + grants — ✅ verified 2026-05-29, no action needed

Checked the live PostgREST endpoint: a request to
`/rest/v1/feature_flags` with `Accept-Profile: resupply` returns a
table-level grant error (`42501`), **not** a schema-exposure error
(`PGRST106 "schema must be one of …"`). That confirms `resupply` is already
in the exposed-schemas list. Grants on the new table match the other 43
`resupply` tables — `service_role` has full privileges incl. `SELECT`, which
is the role the app's readyz probe and `isFeatureEnabled()` use. (The `anon`
role intentionally lacks access; the app never reads flags as `anon`.)

So nothing to do here — left in the runbook only to document the check. If a
future `/readyz` failure shows `db: "unavailable"`, re-run this probe to
distinguish "schema not exposed" from "table missing / grant missing".

### 3. Set required env on the Railway service

The consolidated server refuses to boot unless these are present
(`assertRequiredEnv()`):

- `PORT` (Railway-injected)
- `DATABASE_URL` (Supabase Postgres — used by the migrator + pg-boss worker)
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- `RESUPPLY_LINK_HMAC_KEY` (`openssl rand -base64 48`)
- `RESUPPLY_ALLOWED_ORIGINS` **or** `RAILWAY_PUBLIC_DOMAIN`
- `SUPABASE_STORAGE_BUCKET_PRIVATE`

For the chatbot to actually answer (not just return "offline"), set an LLM
key: **`ANTHROPIC_API_KEY`** (preferred — Claude Sonnet) or `OPENAI_API_KEY`
(gpt-4o-mini fallback). With neither, `/api/chat` stays 200 but returns the
static "chat is offline" reply.

Validate before deploying:

```bash
pnpm --filter @workspace/scripts preflight:prod
```

### 4. Redeploy current `main` and confirm the healthcheck

Trigger a redeploy of `main`. The deploy is only promoted once
`/resupply-api/readyz` returns **200**:

```bash
curl -s https://pennfit.up.railway.app/resupply-api/readyz
# expect: {"status":"ready","checks":{"db":"ok","queue":"ok"}}
```

If it 503s, read `checks` / `errors` in the body:
`db: "unavailable"` → schema not exposed (step 2) or `feature_flags` missing
(step 1); `queue: "schema_not_initialized"` → pg-boss couldn't reach
`DATABASE_URL` (step 3).

### 4a. Verify the Railway service is the consolidated server

The live host serves a **static SPA**, which means the service that owns the
domain is either a leftover static-only service or is misconfigured. In the
Railway project for `pennfit.up.railway.app`, confirm the service that owns
the domain has:

- **Source** = GitHub repo `kdeyarmin/PennFit`, branch `main`, **root
  directory = repo root** (NOT `artifacts/cpap-fitter` — a SPA root makes
  Railpack serve a static site and ignore the API).
- **Builder** = Railpack, honoring root `railway.json`
  (`build.buildCommand = pnpm run build`,
  `deploy.startCommand = node --enable-source-maps artifacts/resupply-api/dist/index.mjs`).
- A successful deploy whose logs show **`resupply-api listening`** (proves
  the Express server — not a static adapter — is the process).

> **Integration-health signal (2026-05-29):** pushing branch
> `claude/intelligent-meitner-n9TZc` + opening PR #415 produced **no Railway
> preview deploy / PR check** (only CodeRabbit posted). Per `CLAUDE.md` a
> push should trigger a Railway preview — its absence suggests the Railway
> GitHub integration is **disconnected or paused**. If so, reconnect it (or
> deploy manually) so production actually tracks `main`.

### 5. Confirm the domain binding

Ensure `pennfit.up.railway.app` (and any custom domain) is bound to the
**single consolidated service** running
`node --enable-source-maps artifacts/resupply-api/dist/index.mjs`
(`railway.json` → `deploy.startCommand`). There must not be a separate
static-SPA service shadowing the domain — the Express process serves the
SPA itself.

### 6. Smoke test

```bash
# Liveness — must be JSON, not HTML
curl -s https://pennfit.up.railway.app/api/healthz
# expect: {"status":"ok","service":"resupply-api"}

# The chatbot endpoint — must be 200 JSON, not 404
curl -s -X POST https://pennfit.up.railway.app/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What masks do you carry?"}]}'
# expect: {"reply":"…"}  (or {"reply":"…","offline":true} if no LLM key yet)
```

Then open the site and confirm PennBot replies in the widget.

## Prevention

- **Add a healthcheck/seed gate to the launch checklist** so a fresh
  environment can never promote without `feature_flags` present and the
  schemas exposed. (`docs/runbooks/production-launch.md` already lists
  "apply migrations" — this incident shows the prod DB skipped the repo's
  migration path entirely.)
- **Reconcile the production DB** with the repo migration history so future
  deploys gate cleanly (`docs/migration-state-investigation-2026-05-08.md`).
- Consider an **uptime probe on `/api/healthz`** that asserts a JSON body
  (not HTML) — that single assertion would have caught "the API isn't being
  served" immediately.
