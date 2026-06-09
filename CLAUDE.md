# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.
For the human-facing setup guide, see [`README.md`](./README.md).

## Start-of-session checklist

Every session — agent or human — must align to the canonical ref **before**
doing any work:

```bash
git status                                          # 1. confirm clean tree
git fetch origin                                    # 2. fetch canonical
git rev-list --count main..origin/main              # 3. how far behind?
# If clean and behind, align (destructive — only when status is clean):
git reset --hard origin/main
```

**Canonical ref:** `main` on `https://github.com/kdeyarmin/PennFit`
(remote-tracking name: `origin/main`).

**Where new work lands:** push a feature branch and open a PR on GitHub.
Never commit directly to local `main`. The pre-commit hook (installed
via `scripts/install-hooks.sh`, source in `scripts/git-hooks/pre-commit`)
blocks commits to local `main` when it falls behind `origin/main`; bypass
with `SKIP_HOOKS=1` only for genuine emergencies.

**Deploy target:** Railway. The repo ships with `railway.json` at the
root; Railpack auto-detects pnpm + Node from `packageManager` and
`engines.node` in the root `package.json` (no `nixpacks.toml` or
`Dockerfile`). Pushing a branch and opening a PR triggers Railway's
GitHub integration to build a preview environment. Production is the
`main`-branch deploy under the `pennfit.up.railway.app` host (or the
bound custom domain `pennpaps.com`). That custom domain is fronted by
**Cloudflare**, which adds an edge cache plus a second proxy hop with two
operator implications: set Cloudflare's Browser Cache TTL to "Respect
Existing Headers" so the app's `immutable` `/assets/` caching reaches
browsers, and verify `trust proxy`/`req.ip` still resolves the real client
(see [`docs/railway-hosting-review-2026-05-29.md`](./docs/railway-hosting-review-2026-05-29.md)
R7). The Express process is started directly by Node
(`node --enable-source-maps artifacts/resupply-api/dist/index.mjs`) so
SIGTERM reaches the graceful-shutdown handler — running it via
`pnpm start` would make pnpm PID 1 and silently swallow SIGTERM on every
deploy rollover.

**Migrations on deploy.** `railway.json` has a `preDeployCommand`
(`node lib/resupply-db/scripts/deploy-migrate.mjs`) that runs the migrator
once per deploy, before the new release goes live, and **gates the deploy
on success** (a migration error keeps the previous release running — it
does not take the site down). It is **opt-in**: it only runs when
`RUN_DB_MIGRATIONS=true`, so it is safe with the flag unset. Production's
ledger has since been **adopted** (the one-time baseline ran — verified
2026-06-06) and `RUN_DB_MIGRATIONS=true` is set, so every deploy now
auto-applies the pending tail; no further baseline step is needed. The
historical adoption procedure (and the verified end state) is preserved in
[`docs/runbooks/adopt-migration-ledger.md`](./docs/runbooks/adopt-migration-ledger.md).
The migrator still refuses a destructive full replay onto a populated,
_unledgered_ database (`migrate.mjs` adoption guard) — that now only
applies to a brand-new environment adopting an existing DB, via
`migrate.mjs --baseline-through=<prefix>`.

Post-mortem of the historical Git-drift event:
[`docs/git-state-2026-05-01.md`](./docs/git-state-2026-05-01.md).

## Merge conflicts in generated files

`pnpm-lock.yaml` is the one auto-generated file that still conflicts on
multi-PR merge trains. `.gitattributes` marks it `-diff merge=binary` so
Git (and GitHub's server-side merge) surface a single "pick one side"
conflict instead of a corrupt line-merge. Locally you get better:
`scripts/install-hooks.sh` registers a `merge.pnpm-lock` driver (via
`.git/info/attributes`, which overrides the committed attribute for your
clone only) that auto-takes one side, plus `post-merge` / `post-rewrite`
hooks that re-run `pnpm install` to reconcile. So after running
`bash scripts/install-hooks.sh`, local merges and rebases no longer halt
on the lockfile. If you ever resolve one by hand:

```bash
git checkout --theirs pnpm-lock.yaml   # or --ours, whichever is closer
pnpm install                           # regenerates from package.json
git add pnpm-lock.yaml
```

**Do NOT hand-edit `lib/resupply-db/drizzle/meta/_journal.json`.** Despite
the older guidance to "splice" it, that file is **frozen** at 52 entries
and is no longer appended to (new migrations are not journaled — there are
180+ `.sql` files but only 52 journal entries). It therefore does not
actually conflict anymore. Splicing or rebuilding it can make `migrate.mjs`
re-apply or skip migrations against production — see
[`docs/migration-state-investigation-2026-05-08.md`](./docs/migration-state-investigation-2026-05-08.md).
Its `-diff merge=binary` marker stays only as a guard; if it ever
conflicts, take either side verbatim and do not merge entries by hand.

Do NOT add `merge=union` or `merge=ours` for source files in
`artifacts/` or `lib/` — those are real edits and silently dropping a
side is worse than a visible conflict.

## Repository map

This is a `pnpm` workspaces monorepo (Node v24, TypeScript ~6.0, pnpm 11.5.2).
Workspace globs (`pnpm-workspace.yaml`): `artifacts/*`, `lib/*`,
`lib/integrations/*`, and `scripts`.

| Path                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifacts/resupply-api`     | Single Express 5 API process. Hosts the storefront/fitter routes (`/api/*`), the resupply admin/voice routes (`/resupply-api/*`), AND the in-process `pg-boss` worker (reminders + PHI sweep) booted from `src/worker/index.ts`.                                                                                                                                                                       |
| `artifacts/cpap-fitter`      | Customer-facing SPA (Vite + React + Wouter + Tailwind). Mounts the internal admin console at `/admin/*` (gated by `useGetAdminMe`); legacy `/resupply/*` URLs SPA-redirect to `/admin/*` preserving query strings.                                                                                                                                                                                     |
| `artifacts/shared`           | Cross-artifact static assets (favicons served at root).                                                                                                                                                                                                                                                                                                                                                |
| `lib/resupply-*`             | Shared workspace packages: `db`, `auth` (+ `auth-react`), `messaging`, `email`, `ai`, `telecom`, `audit`, `domain`, `secrets`, `reminders`, `templates`.                                                                                                                                                                                                                                               |
| `lib/resupply-integrations*` | Partner-connectivity layer (therapy-cloud pulls, inbound order webhooks, payer/claims). `lib/resupply-integrations` is the shared contract; the per-vendor adapters live alongside it. See **Integrations layer** below.                                                                                                                                                                               |
| `lib/api-client-react`       | Hand-maintained API client + React hooks (`src/{admin,storefront}/generated/`).                                                                                                                                                                                                                                                                                                                        |
| `scripts/`                   | Architecture/route/migration drift checks (`check-resupply-architecture`, `check-admin-route-gates`, `check-resupply-migration-prefix`, `ci-check-ts-syntax`) plus operator utilities under `src/`: `preflight-prod-env.ts` (env validator), `verify-deploy.ts` (post-deploy routing probe), `auth-bootstrap-admin.ts` / `auth-set-admin-password.ts`, `seed-stripe-products.ts`, `probe-supabase.ts`. |
| `e2e/`                       | Playwright end-to-end suite (storefront load, results-page resilience, axe a11y). Run from the repo root, not a workspace.                                                                                                                                                                                                                                                                             |
| `docs/`                      | Architecture notes, post-mortems, production readiness, runbooks.                                                                                                                                                                                                                                                                                                                                      |

There is **one** customer-facing site (`pennfit.up.railway.app/` or your
bound custom domain). The former separate `api-server`,
`resupply-worker`, and `resupply-dashboard` artifacts were folded in
during the May 2026 consolidations.

## Common commands

```bash
pnpm install                                      # workspace install
pnpm typecheck                                    # tsc --build + per-app typecheck
pnpm build                                        # typecheck, then build everywhere
pnpm lint:resupply                                # ESLint, zero warnings
pnpm format        / pnpm format:check            # Prettier write / check
pnpm test                                         # Vitest across all packages
pnpm --filter <pkg> test                          # Vitest for one package
pnpm --filter <pkg> test -- <file> -t "<name>"    # one file / one test by name
pnpm test:e2e      / pnpm test:e2e:ui             # Playwright (e2e/, headless / UI)
pnpm --filter @workspace/resupply-api dev         # API + in-process worker
pnpm --filter @workspace/cpap-fitter dev          # storefront + admin SPA
```

Tests are Vitest per-package; `--passWithNoTests` is set so packages with no
specs don't fail the run. The e2e suite uses Playwright and is configured at
`e2e/playwright.config.ts` (run from the repo root, not via `--filter`).

Operator-facing utilities under `scripts/` (all `tsx` entrypoints):

```bash
pnpm --filter @workspace/scripts preflight:prod        # validate process.env
                                                       # against production
                                                       # constraints (see
                                                       # docs/runbooks/
                                                       # production-launch.md)
pnpm --filter @workspace/scripts verify:deploy -- <url> # confirm the API (not
                                                       # just the SPA) is routed
                                                       # after a deploy
pnpm --filter @workspace/scripts auth:bootstrap-admin  # seed the first admin
                                                       # row + email a 1h
                                                       # password-reset link
pnpm --filter @workspace/scripts auth:set-admin-password # reset an admin's
                                                       # password directly
```

Locally, set `PORT` and `BASE_PATH` per-artifact before running `pnpm
--filter @workspace/<artifact> dev`. The cpap-fitter SPA expects
`BASE_PATH=/` and a free port (typically 5173); the resupply-api
expects a port distinct from the SPA (typically 3000). On Railway,
`PORT` is injected by the platform and `BASE_PATH` defaults to `/`.

## Hard rules — do not break

These are non-negotiable invariants of the codebase. Treat them as
correctness, not style:

- **No image logging anywhere in the backend.** Camera images and video
  frames never leave the browser; only numeric facial measurements are
  transmitted. Do not add log lines that include image bytes, base64,
  data URLs, or paths to camera-derived blobs.
- **No order request bodies in the application logger.** Treat every log
  line as world-readable. Order payloads contain PHI.
- **No new column-level encryption.** Migration 0025 stripped pgcrypto
  PHI encryption and dropped `phone_lookup`; `RESUPPLY_MASTER_KEY`,
  `RESUPPLY_DATA_KEY`, and `RESUPPLY_PHONE_HMAC_KEY` are no longer read
  by any code path.
- **No password pepper.** Task #38 removed `AUTH_PASSWORD_PEPPER`;
  passwords are hashed with plain argon2id. Stale pepper values in the
  environment are silently ignored.
- **No HIPAA / DMEPOS / ACHC compliance machinery.** Migration 0156
  retired all 11 in-app compliance domains (audit-log tamper-evidence,
  BAA inventory, DMEPOS staff policy attestation, staff training
  records, patient grievances, OIG LEIE screening, patient rights
  requests, patient disclosure log, contingency drills, ACHC QAPI,
  DME ownership disclosure). The `@workspace/resupply-audit` package
  is a no-op stub kept for back-compat with 150+ callsites — don't
  write new audit logic against it. `RESUPPLY_AUDIT_HMAC_KEY` is no
  longer read by any code path. Compliance is now handled out of band
  by the business owner. The three historical `audit_log` readers
  (`/admin/delivery-failures` system-events stream,
  `/admin/feature-flags/activity`, and
  `/admin/analytics/csr-productivity`) now short-circuit to
  route-specific degraded responses (for example, delivery failures
  returns `auditEventsUnavailable: true`) so the SPA can render an
  explicit "no longer tracked" notice; new readers must NOT add
  `.from("audit_log")` calls. The `/readyz` DB probe was moved off
  `audit_log` onto `feature_flags`.
- **One From address.** Every outbound email funnels through
  `lib/resupply-email`'s `createSendgridClient()`; `SENDGRID_FROM_EMAIL`
  is `info@pennpaps.com`. Don't bypass the shared client.
- **Admin theme stays scoped.** Admin tokens (`--penn-navy`, etc.) live
  in `src/admin.css` under `.admin-root`. Every admin surface must wrap
  its outer `<div>` with `className="admin-root"` so it doesn't clobber
  storefront brand tokens. Do **not** add a global `@theme` block to
  `admin.css` to remap shared shadcn tokens (`--color-background`, etc.):
  Tailwind v4 emits `@theme` utilities **globally**, so they override the
  storefront's own `.bg-background` / `.text-foreground` / … the moment
  the lazy-loaded admin stylesheet is in the document — and since the
  admin values live only under `.admin-root`, every storefront surface
  then resolves to an undefined variable and renders transparent (this is
  what left the PennBot panel see-through). Re-point shadcn tokens for the
  admin pages by overriding the **raw** `--background` / `--foreground` /
  … variables under `.admin-root` (the storefront utilities already read
  them). Enforced by `artifacts/cpap-fitter/src/admin.scope.test.ts`.

## Service boot contract

Long-running services validate required env vars at startup and fail fast
with a single error listing **every** missing variable. Optional / feature-
gated variables (Twilio, SendGrid, OpenAI, Stripe, object storage) degrade
gracefully when unset so dev/preview environments don't need every
third-party credential.

**HTTP serving is decoupled from the in-process worker** (`src/index.ts`):
the Express listener binds first, then pg-boss starts in the background and
retries on a backoff if it can't reach Postgres. A worker/DB hiccup must
NOT take the whole site down — the static storefront and the public shop
catalog (Stripe-less preview fallback) need neither the worker nor the DB.
Accordingly Railway's health check is `/resupply-api/healthz` (liveness,
no dependency), **not** `/readyz`; `/readyz` still reports DB + worker
readiness but is a monitoring/alerting signal, not a deploy gate. Don't
re-couple them (don't `process.exit` on worker-boot failure, don't point
the health check back at `/readyz`) — that's what blackholed the entire
site behind one failing dependency. After any deploy, confirm the API is
actually routed (not just the SPA) with
`pnpm --filter @workspace/scripts verify:deploy -- https://<host>`.

Required at boot for `resupply-api` (the API refuses to start if any
of these is missing):

| Variable                                                  | Notes                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                    | HTTP listen port.                                                                                                                                                                                                                                                                                   |
| `DATABASE_URL`                                            | Postgres v14+ (no extensions; only `gen_random_uuid()` is used). Used by the migrator and a small number of legacy worker paths; the runtime data path is Supabase, not raw pg.                                                                                                                     |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`              | Runtime data path. Validated by `validateSupabaseEnv()` in `lib/resupply-db/src/supabase-client.ts`. Service-role JWT bypasses RLS; never expose client-side. Both `resupply` and `resupply_auth` schemas must be added to Studio → Project Settings → API → "Exposed schemas" or every query 503s. |
| `RESUPPLY_LINK_HMAC_KEY`                                  | 32+ random bytes. Signs short-lived patient links in SMS/email reminders. Generate with `openssl rand -base64 48`. Rotation invalidates in-flight links.                                                                                                                                            |
| `RESUPPLY_ALLOWED_ORIGINS` **or** `RAILWAY_PUBLIC_DOMAIN` | CORS allowlist (origin form for the first, bare-host for the second). In `NODE_ENV=production` the API throws at boot if both are empty — `artifacts/resupply-api/src/app.ts`. Railway deployments auto-populate `RAILWAY_PUBLIC_DOMAIN`.                                                           |
| `SUPABASE_STORAGE_BUCKET_PRIVATE`                         | Bucket name in Supabase Storage where customer attachments (POD photos, prescription PDFs, MMS media) are uploaded. The PHI sweep job refuses to register without it.                                                                                                                               |

`preflight:prod` (under `scripts/`) validates every row above plus
production-only shape checks (sk_live vs sk_test, strict base64 round-trip
on HMAC keys, HTTPS-only public URLs, `.env.example` placeholder
detection, the `STRIPE_WEBHOOK_SECRET` legacy-alias name confusion).
Exits non-zero on any FAIL so it can gate a deploy. The first-launch
procedure that walks through generating keys → setting secrets → running
preflight → applying migrations → bootstrapping the first admin is in
[`docs/runbooks/production-launch.md`](./docs/runbooks/production-launch.md).

The full env table — including every optional variable and where it's
read — lives in [`README.md`](./README.md#environment-variables) and
[`.env.example`](./.env.example).

## AI / communications stack (May 2026)

Three independent AI vendors are wired into the codebase, each used
where it's strongest. All three are HIPAA-eligible and gracefully
degrade when their API key is unset.

| Surface                 | Primary                                        | Fallback                           | Key                                                |
| ----------------------- | ---------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| Voice agent (LLM brain) | OpenAI `gpt-realtime`                          | n/a (offline if down)              | `OPENAI_API_KEY`                                   |
| Voice agent (STT)       | `gpt-4o-mini-transcribe`                       | Deepgram Nova-3 (opt)              | `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`               |
| Voice agent (TTS)       | ElevenLabs (when key set), else OpenAI `cedar` | OpenAI `cedar` (no ElevenLabs key) | `ELEVENLABS_API_KEY` (preferred), `OPENAI_API_KEY` |
| Storefront chatbot      | Claude Sonnet 4.6                              | `gpt-4o-mini`                      | `ANTHROPIC_API_KEY` (preferred), `OPENAI_API_KEY`  |
| Sleep coach             | Claude Sonnet 4.6                              | `gpt-4o-mini`                      | `ANTHROPIC_API_KEY` (preferred), `OPENAI_API_KEY`  |
| SMS intent classifier   | Claude Haiku 4.5                               | `gpt-4o-mini`                      | `ANTHROPIC_API_KEY` (preferred), `OPENAI_API_KEY`  |

Provider selection happens in
`artifacts/resupply-api/src/lib/llm-provider.ts:selectLlmProvider()` —
when `ANTHROPIC_API_KEY` is set, Claude takes priority for every
text-only LLM call (Sonnet 4.6 writes noticeably warmer patient-facing
copy than gpt-4o-mini-class models and is at least as strong on tool
selection). When only `OPENAI_API_KEY` is configured, OpenAI is used
end to end. When neither is set, routes return a static "offline"
reply and stay 200 (deploys must not break because a vendor key is
missing).

Vendor clients live in `lib/resupply-ai/src/`:

- `anthropic-client.ts` — Claude Messages API (REST + SSE streaming +
  prompt caching). `createAnthropicClient()`. Used by the chatbot,
  sleep coach, SMS classifier, and the **post-call summarizer** in
  `artifacts/resupply-api/src/lib/voice/post-call-summary.ts`.
- `deepgram-client.ts` — Nova-3 STT (REST batch + WebSocket
  streaming). `createDeepgramClient()`. Wired into the voice WS
  handler when `DEEPGRAM_API_KEY` is set: opens a parallel Nova-3
  session on the caller-side µ-law audio, accumulates final
  transcripts, and writes a `voice.call.deepgram_transcript` audit
  row on hangup. The OpenAI Realtime model still drives the
  conversation — Deepgram is the audit-grade backup transcript.
- `elevenlabs-client.ts` (REST) + `elevenlabs-stream.ts` (stream-input
  WebSocket) — TTS. **Wired into the live voice path**: when
  `ELEVENLABS_API_KEY` is set, ElevenLabs becomes the agent's voice —
  the `RealtimeClient` is constructed with `generateAudio: false`
  (text-output mode) and the bridge produces the audio through ElevenLabs
  (`ulaw_8000`, re-framed to 160-byte µ-law frames) and streams it to
  Twilio. Two transports, selected by `ELEVENLABS_TTS_TRANSPORT`:
  - **`ws` (default)** — `VoiceBridge`'s `TtsStreamer` opens ONE
    stream-input WS per agent turn (`openElevenLabsStream`) and feeds the
    model's output text in as it's generated; audio streams back over the
    whole turn. Lowest time-to-first-word and best cross-sentence prosody.
  - **`http`** — `VoiceBridge`'s `TtsSynthesizer` voices each complete
    **sentence** as it lands via the REST streaming endpoint (the turn's
    `done` flushes only the un-spoken tail). The proven fallback.

  ElevenLabs uses `DEFAULT_CONVERSATIONAL_VOICE_SETTINGS` (warm
  conversational tuning) and defaults to the low-latency
  `eleven_flash_v2_5` model; voice, model, stability, speed, and transport
  are all env-overridable (`ELEVENLABS_VOICE_ID` / `_MODEL_ID` /
  `_STABILITY` / `_SPEED` / `_TTS_TRANSPORT`). Caller barge-in
  (`input.speech_started`) aborts the in-flight session/synthesis and
  flushes the sink. When the key is **unset**, the bridge forwards
  OpenAI's built-in `cedar` audio unchanged (the historical default) — so
  a missing key degrades gracefully, never breaks the call. A mid-call
  ElevenLabs failure drops that one turn's audio (logged as a `tts`
  session error) but does NOT end the call. **PHI:** synthesised text is
  patient-facing speech.

**Post-call summarization** (`artifacts/resupply-api/src/lib/voice/post-call-summary.ts`)
runs Claude Sonnet 4.6 on the accumulated transcript turns after every
voice call ends. Produces a structured JSON object with the call
outcome, patient sentiment (`positive | neutral | concerned |
distressed`), any clinical concerns mentioned, follow-ups the agent
committed to, and a `recommendsHandoff` flag for the human-review
queue. Persisted as a `voice.call.summary` audit row. Fires
fire-and-forget after `voice.call.completed` — a flaky model call
NEVER delays hangup.

Voice agent prompt: `lib/resupply-ai/src/prompts.ts` (version
`2026-06-09.v7`). Tuned for natural prosody — contractions,
backchannels, brief empathy, natural hesitations, reacting before moving
on, varied openers, one question at a time, and conversational
(non-list) read-back. The Realtime
session uses `semantic_vad` with `eagerness: "low"` and `temperature:
0.8` for natural turn-taking and phrasing variation (see
`lib/resupply-ai/src/realtime-client.ts`). The agent's voice is
ElevenLabs when `ELEVENLABS_API_KEY` is set, otherwise OpenAI's built-in
`cedar` (the warmest of the current Realtime voices) — see the
ElevenLabs entry under **Vendor clients** above.

## Integrations layer (`lib/resupply-integrations*`)

Partner connectivity is split into one shared contract package plus a
family of per-vendor adapters. `lib/resupply-integrations` owns the
unified types, the `IntegrationAdapter` contract, and the Zod schemas;
every vendor package depends on it and on nothing in the data layer.
The adapters cover three distinct domains:

| Domain                       | Packages                                                                                      | Direction       |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------- |
| Therapy-cloud device data    | `-airview` (ResMed), `-care-orchestrator` (Philips), `-react-health` (3B Medical)             | pull / ingest   |
| Payer / claims / prior-auth  | `-office-ally` (837P/835/277CA clearinghouse over SFTP), `-davinci-pas` (FHIR PAS prior auth) | outbound        |
| DME billing system (PacWare) | `-pacware` (legacy desktop billing; **CSV file exchange, no API**)                            | import + export |

Wiring & conventions:

- **Therapy adapters** register in
  `artifacts/resupply-api/src/lib/integrations/registry.ts` as a
  module-level `Map<IntegrationSource, IntegrationAdapter>`. Each
  implements `availability()` + `fetchSnapshot(input)`. The registry is
  built at boot but env vars are read at **call** time, so credential
  rotation is honored without a restart. A nightly pg-boss job
  (`therapy-integrations.nightly-sync`) walks the map and skips any
  adapter whose `availability().status` is `"unavailable"`.
- **Payer adapters** are imported directly by their route handlers /
  job processors (no central registry). Office Ally supports a **stub
  mode** (`OFFICE_ALLY_STUB=1` or missing creds) that writes the 837P to
  `OFFICE_ALLY_FILE_OUTBOX_DIR` instead of SFTP-uploading.
- **PacWare (`-pacware`)** is a CSV **file exchange**, not an adapter:
  PacWare is a legacy desktop billing system with no API. The pure package
  owns the report column catalog + tolerant CSV parser + exporter; the
  routes (`artifacts/resupply-api/src/routes/admin/pacware.ts`) own DB +
  audit; the admin UI is `/admin/pacware`. Patient import is a **fill-only
  sync** on `patients.pacware_id`: new patients are inserted, existing ones
  only have **blank** fields filled — an existing value is **never
  overwritten** (reports created/updated/unchanged). The PennFit→PacWare
  exports (patient roster, resupply-due worklist) are surfaced as **"Sync to
  PacWare"** actions with a **verify** step (preview count+sample before
  download), are formula-injection-guarded, and the importer reverses the
  guard for lossless round-trips. An opt-in `pacware.auto_sync` toggle
  (`app_config`, non-catalog key) drives an in-app "ready to sync" notice;
  nothing is ever pushed automatically (PacWare has no API). PacWare is the
  billing/warehouse system of record; PennFit is the resupply engine. See
  [`docs/integrations/pacware.md`](./docs/integrations/pacware.md) and the
  operator manual
  [`docs/runbooks/pacware-import-export.md`](./docs/runbooks/pacware-import-export.md).
- **Feature-gated, fail-soft.** Each package exposes a
  `read…ConfigOrNull()` helper; missing env → `availability` reports
  `"unavailable"` (the admin UI shows a badge without leaking which var
  is unset) rather than throwing at boot.
- **No DB imports.** Like the other pure libs, integration packages must
  not import `pg` or `@workspace/resupply-db` — persistence happens only
  in the registry/route layer. Adapters return summary numerics + status
  strings; raw vendor response bodies are never logged or persisted.

## Conventions worth knowing

- **Validation:** Zod at every HTTP boundary in `resupply-api`.
- **DB:** the runtime data path is the **Supabase service-role client**
  exported from `@workspace/resupply-db` as
  `getSupabaseServiceRoleClient()`; every route, worker, and helper
  reads/writes through PostgREST via that client. **Supabase is the
  only data path** — `drizzle-orm`, `drizzle-kit`, `drizzle-zod`,
  `drizzle.config.ts`, the `src/schema/**` TS schema directory, and
  the structural `check-drizzle-drift.sh` CI check have all been
  retired. The SQL files in `lib/resupply-db/drizzle/*.sql` are the
  source of truth for migration history; `lib/resupply-db/scripts/migrate.mjs`
  applies them via raw `pg`. New migrations are hand-written SQL
  (or generated via Supabase's own tooling). The directory name and
  the on-DB `drizzle.resupply_migrations` history schema are kept
  unchanged so production's applied-migration rows continue to gate
  new deploys cleanly; a rename is tracked as a separate operational
  change. `getDbPool` is still called by `scripts/migrate.mjs` and a
  small number of legacy worker paths (e.g.
  `artifacts/resupply-api/src/worker/jobs/bulk-campaign-tick.ts`).
  The "no direct `pg` outside `lib/resupply-db`" invariant is enforced
  by Rule 7 in `scripts/check-resupply-architecture.sh`; the same
  script also forbids `drizzle-orm` imports in `lib/resupply-domain`
  (Rule 2). The remaining schema-drift pre-commit guard is
  `scripts/check-resupply-migration-prefix.sh` (the historical
  co-change pair-check was retired with the TS schema directory).
- **Auth:** in-house, `argon2id` + DB-backed `pf_session` cookies
  (`lib/resupply-auth/src/cookies.ts:7`). Admin auth flows live under
  `/admin/sign-in`, `/admin/forgot-password`, `/admin/reset-password`,
  `/admin/verify-email`. The admin role gate (`requireAdmin`) reads
  `auth.users.role` directly — there is no env-var allowlist anymore
  (`artifacts/resupply-api/src/middlewares/requireAdmin.ts:21`).
  `RESUPPLY_ADMIN_EMAILS` / `RESUPPLY_AGENT_EMAILS` are display-only
  now (populate count tiles on `/admin/operations`); the auth gate
  ignores them. Bootstrap the first admin via
  `pnpm --filter @workspace/scripts auth:bootstrap-admin --email=… --role=admin`.
  Beyond the coarse `requireAdmin`, finer-grained admin routes use
  `requirePermission("…")`; `scripts/check-admin-route-gates.sh` audits
  every admin mutation at CI time and fails only on routes with **neither**
  gate (a route with no gate is public — a real bug).
- **Inbound MMS:** webhook downloads each `MediaUrlN` with HTTP basic auth
  (5s/media timeout, 5MB cap, image/\* + application/pdf allowlist, max 10
  attachments/message), uploads to Supabase Storage
  (`SUPABASE_STORAGE_BUCKET_PRIVATE`), persists as `message_attachments`.
  Audit emits counts only — no media URLs, no PHI.
- **Object storage:** Supabase Storage. All uploads (POD photos,
  prescription PDFs, MMS media) land in the bucket named in
  `SUPABASE_STORAGE_BUCKET_PRIVATE`. Per-object ACL lives in
  `resupply.object_storage_acls` (migration 0165) — not in bucket-level
  RLS, not in object metadata. The public API surface is
  `ObjectStorageService` in
  `artifacts/resupply-api/src/lib/object-storage/objectStorage.ts`.
- **API clients:** `lib/api-client-react/src/{admin,storefront}/generated/`
  and `lib/resupply-api-client/src/generated/` are the source of truth
  for client-side HTTP types — they used to be generated from OpenAPI
  specs, but Task #37 deleted both `@workspace/resupply-api-spec` and
  `@workspace/api-spec` along with the orval pipeline. The directories
  are now hand-edited; any drift check would be a no-op.

## When in doubt

- For product/architecture questions, read [`README.md`](./README.md).
- For env setup, read [`.env.example`](./.env.example) and
  [`README.md`](./README.md).
- For first-launch / deploy-side procedure, read
  [`docs/runbooks/production-launch.md`](./docs/runbooks/production-launch.md)
  (paired with the broader checklist in
  [`docs/PRODUCTION_READINESS.md`](./docs/PRODUCTION_READINESS.md)).
- For how Railway builds & runs the repo (the `railway.json` fields, the
  service-boot contract, Node/pnpm version resolution, and the pre/post-deploy
  probes), read [`docs/railway-deployment.md`](./docs/railway-deployment.md)
  (point-in-time audit:
  [`docs/railway-hosting-review-2026-05-29.md`](./docs/railway-hosting-review-2026-05-29.md)).
- For env-shape validation before a deploy, run
  `pnpm --filter @workspace/scripts preflight:prod`.
- For the Git source-of-truth rule, the post-mortem in
  [`docs/git-state-2026-05-01.md`](./docs/git-state-2026-05-01.md)
  explains _why_; follow the start-of-session checklist above to comply.
- For threat-model questions, see [`threat_model.md`](./threat_model.md).
