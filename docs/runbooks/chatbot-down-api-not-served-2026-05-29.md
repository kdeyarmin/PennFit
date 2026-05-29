# Storefront chatbot down — production API not served (2026-05-29)

The customer-facing chatbot ("PennBot") errored for every message with
_"Something went wrong reaching the chat service … connection issue"_.

This runbook captures the root cause and the **operator-only** steps to
restore it. The chatbot **code is healthy** — the problem is that the
consolidated `resupply-api` server is not the thing answering at
`pennfit.up.railway.app`; a stale **static-SPA-only** deploy is, so every
API call (including `POST /api/chat`) 404s.

| # | Step | Where it runs | Status |
| - | ---- | ------------- | ------ |
| 1 | Create `resupply.feature_flags` (+ seed) in the prod DB | Supabase (PennPaps) | ✅ **Done 2026-05-29** (migration `0149`) |
| 2 | Expose `resupply` + `resupply_auth` schemas to PostgREST | Supabase dashboard | ☐ Operator |
| 3 | Set required env on the Railway service | Railway dashboard → Variables | ☐ Operator |
| 4 | Redeploy current `main`; confirm `/readyz` 200 & deploy promotes | Railway dashboard → Redeploy | ☐ Operator |
| 5 | Confirm the domain is bound to the consolidated service | Railway dashboard → Settings → Domains | ☐ Operator |
| 6 | Smoke-test the chatbot end to end | Your laptop / browser | ☐ Operator |

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

### 2. Expose `resupply` + `resupply_auth` to PostgREST

Supabase Studio → **Project Settings → API → Exposed schemas** — add
`resupply` and `resupply_auth`. The runtime data path is the Supabase
service-role client; if these schemas aren't exposed, **every** PostgREST
query 503s (including the `/readyz` probe above). This is a documented hard
requirement (see `CLAUDE.md` → Service boot contract).

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
