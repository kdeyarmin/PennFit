# AGENTS.md

Canonical agent guidance for this repo lives in [`CLAUDE.md`](./CLAUDE.md)
(architecture, hard rules, migrations, deploy contract) and
[`README.md`](./README.md) (setup, env vars, standard commands). Read those
first. This file only adds the Cursor Cloud environment notes below.

## Cursor Cloud specific instructions

This is a `pnpm` workspaces monorepo with two runnable apps:

- **`@workspace/resupply-api`** — Express API + in-process pg-boss worker
  (serves `/api/*` storefront + `/resupply-api/*` admin/voice). Dev: it
  rebuilds with esbuild then runs `node dist/index.mjs` — **there is no
  watch / hot reload; restart it after backend changes.** Liveness
  `/resupply-api/healthz`, readiness `/resupply-api/readyz` (reports
  `db` + `queue`).
- **`@workspace/cpap-fitter`** — Vite + React SPA (customer storefront +
  admin console at `/admin/*`).

Standard lint/typecheck/test/build commands are in `README.md` /
`CLAUDE.md` (`pnpm typecheck`, `pnpm lint:resupply`, `pnpm test`,
`pnpm build`). All pass in this environment.

### Toolchain (Node version gotcha)

The repo pins `engines.node=24.x` and `pnpm@11.5.2`. The platform's
default `node` on `PATH` (`/exec-daemon/node`) is **v22** and shadows nvm,
which breaks native modules (`argon2`). This environment is wired so that:

- Interactive/login shells get Node 24 (a PATH prepend was added to
  `~/.bashrc`).
- The startup **update script** runs `pnpm install` under Node 24 via nvm.

If you ever see a Node 22 ABI / native-module error, run
`nvm use 24` (or open a fresh login shell) before re-running.

### Running end-to-end locally (the non-obvious part)

The runtime data path is a **Supabase project**. There is no hosted
project here; local dev uses a **local Supabase stack** (Docker +
`supabase` CLI, both pre-installed). `supabase/config.toml` is committed
(it exposes the `resupply` + `resupply_auth` PostgREST schemas and disables
analytics).

1. **Docker daemon** (no systemd in this VM): if `docker info` fails,
   start it once: `sudo dockerd >/tmp/dockerd.log 2>&1 &` then
   `sudo chmod 666 /var/run/docker.sock`.
2. **Bring up + seed the DB** (idempotent, ~30s): `bash scripts/dev-local-supabase.sh`.
   This runs `supabase start`, applies the 314 SQL migrations
   (`lib/resupply-db/scripts/migrate.mjs`), grants the Supabase data-API
   roles on the `resupply`/`resupply_auth` schemas, creates the private
   storage bucket, and seeds a verified dev admin.
3. **`.env`** is git-ignored and already contains the local Supabase
   defaults + a dev HMAC key. The apps do **NOT** auto-load `.env`, so
   source it into the process env before starting the API:
   `set -a; . ./.env; set +a`.
4. **API** (port 3000): `pnpm --filter @workspace/resupply-api dev`
   (after sourcing `.env`).
5. **SPA** (port 5173, proxies to the API): the Vite config **throws** if
   `PORT` or `BASE_PATH` is unset, and `PORT` must differ from the API:
   `PORT=5173 BASE_PATH=/ API_PROXY_TARGET=http://localhost:3000 pnpm --filter @workspace/cpap-fitter dev`.

**Dev admin (created by step 2):** `admin@pennpaps.local` /
`PennFitDev123!` — sign in at `http://localhost:5173/admin/sign-in`.

### Gotchas worth remembering

- **PostgREST won't start** unless the exposed schemas exist on a fresh DB
  — `supabase/migrations/00000000000000_bootstrap_resupply_schemas.sql`
  pre-creates them so `supabase start` succeeds before app migrations run.
- **Sign-in 500 "credentials store" / "permission denied for sequence ..."**
  means the Supabase data-API roles lack grants on the freshly-migrated
  tables (migrations create objects as `postgres`). Re-run
  `scripts/dev-local-supabase.sh` (it applies the grants + a PostgREST
  schema-cache reload).
- **`email_unverified` on sign-in:** local dev has no SendGrid, so email
  verification can't complete the normal way; the helper stamps
  `email_verified_at` for the dev admin directly.
- Vendor integrations (Stripe, SendGrid, Twilio, OpenAI/Anthropic/Deepgram/
  ElevenLabs, Telnyx, Office Ally) are all optional and degrade gracefully
  when their keys are unset — not needed for local dev.
- A fresh VM gets an empty Supabase DB (the Docker volume is not part of
  the repo), so re-run `scripts/dev-local-supabase.sh` after any
  `supabase start` on a clean machine.
