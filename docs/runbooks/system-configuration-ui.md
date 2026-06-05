# Super-admin System Configuration UI

`/admin/system/configuration` lets a **super-admin** enter and rotate
integration credentials and platform secrets — AI vendor keys, Twilio,
SendGrid, Stripe, the therapy-cloud OAuth credentials, and Office Ally —
that historically lived only as Railway environment variables.

- **Frontend:** `artifacts/cpap-fitter/src/pages/admin/admin-system-configuration.tsx`
  (nav: System → Settings → Configuration).
- **API:** `artifacts/resupply-api/src/routes/admin/app-config.ts`
  (`GET/PUT/DELETE /admin/system/config`, `GET /admin/system/config/activity`).
- **Catalog:** `artifacts/resupply-api/src/lib/app-config/catalog.ts`.
- **Resolver:** `artifacts/resupply-api/src/lib/app-config/store.ts`.
- **Schema:** `lib/resupply-db/drizzle/0211_app_config.sql`
  (`resupply.app_config`, `resupply.app_config_events`).

## Access

Every route is gated on the `system.config.manage` permission, which
**only the `super_admin` role holds** (the DB `admin` role — see
`lib/resupply-auth/src/rbac.ts`). Plain admins and CSRs get a 403, and the
nav entry is hidden for them. The `/me` endpoints now return the caller's
`permissions` so the SPA can gate the nav entry accordingly.

### Granting super-admin

`super_admin` resolves from **`resupply.admin_users.role = 'admin'`** (via
`toEffectiveRole()`). `requireAdmin` falls back to the coarse
`resupply_auth.users.role` when a user has **no** `admin_users` row, so a
freshly bootstrapped `admin` reaches super_admin by that fallback — but
the grant is implicit and fragile (adding a lower-role `admin_users` row
later silently demotes them). Make it explicit and durable:

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
pnpm --filter @workspace/scripts auth:grant-super-admin --email=<addr>
```

The user must already exist (run `auth:bootstrap-admin` first to create
the account + set a password). `auth:grant-super-admin`
(`scripts/src/auth-grant-super-admin.ts`) is idempotent: it ensures the
coarse role is `admin` **and** upserts an `admin_users` row with
`role='admin'`, `status='active'`, linked via `auth_user_id`. It issues
no password reset and sends no email, so it's safe to re-run. Unlike
`auth:bootstrap-admin`, it writes the granular row the team console and
the `system.config.manage` gate actually read.

## How values are stored (read this before changing the schema)

- One row per setting in `resupply.app_config`, keyed by the **literal
  environment-variable name** (`OPENAI_API_KEY`, `AIRVIEW_CLIENT_SECRET`,
  …). The key being identical to the env var is what lets a stored value
  overlay `process.env[key]` directly — no name-mapping layer.
- `value` is **plaintext**. Per the repo hard rule *"No new column-level
  encryption"* (migration 0025 stripped pgcrypto), there is no at-rest
  column encryption. The protection model is:
  1. the table is reachable only via the **service-role** client
     (server-side; never the browser),
  2. the read API **masks** secret values (a last-4 hint, never the
     plaintext — the plaintext never crosses the wire and is never
     logged), and
  3. only `system.config.manage` (super_admin) can read or write it.
- `app_config_events` is a value-free audit of writes (key, `set`/`clear`,
  whether a prior value existed, operator, timestamp). It powers the
  "Recent activity" panel and never stores a secret.

## Precedence

A DB value **wins over** the matching Railway environment variable for
catalog keys — entering a value in the UI is meant to be authoritative.
*Clear* removes the row and the environment value takes over again. When
both exist, the UI shows the DB value with an "also set in environment
(overridden)" note.

## When a saved value takes effect

| Apply mode | Settings | Mechanism |
| --- | --- | --- |
| **Live** | Therapy cloud (ResMed AirView, Philips Care Orchestrator, 3B Medical / React Health) | The integration registry rebuilds per call from `getEffectiveEnv()` (DB overlay on `process.env`), so a rotated credential takes effect on the next nightly sync / manual refresh — no restart. |
| **On next deploy** | Everything else (AI vendors, Twilio, SendGrid, Stripe, Office Ally) | These are read at boot or by a vendor client built at boot. `applyAppConfigOverlayToEnv()` folds saved values into `process.env` **once at startup**, in the decoupled post-listen boot path (fail-soft, never blocks the listener). They're picked up at the next service restart / deploy. |

## Scope: optional/feature-gated keys only

The catalog deliberately contains **only** the optional, feature-gated
env vars that already degrade gracefully when unset. The bootstrap
credentials the process needs just to start — `DATABASE_URL`,
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, `PORT`,
`RESUPPLY_LINK_HMAC_KEY`, the CORS allowlist,
`SUPABASE_STORAGE_BUCKET_PRIVATE` — are **never** in the catalog and the
store hard-excludes them as defense in depth. This avoids any "need the
DB to read the creds that reach the DB" cycle and any env-check ordering
hazard at boot.

## Kill switch

Set `APP_CONFIG_OVERLAY_DISABLED=1` to bypass the DB overlay entirely
(both the live overlay and the boot merge). Saved values stay in the
table but are not applied — useful if a bad row ever needs to be ignored
without a DB round-trip. The UI shows a warning banner when this is set.

## Adding a new setting

1. Add an entry to `APP_CONFIG_CATALOG` in
   `artifacts/resupply-api/src/lib/app-config/catalog.ts` with its `key`
   (the env var name), `label`, `category`, `secret`, `applyMode`, and
   `description`.
2. That's it for storage + the UI. If the value should take effect
   **live**, make sure the code path that reads it goes through the
   effective-env overlay (today only the integration registry does);
   otherwise it's an "on next deploy" setting and the boot merge handles
   it.
3. Do **not** add a bootstrap/boot-required key (see the denylist in
   `store.ts`). `store.test.ts` guards against this.
4. Optionally add a **format rule** for the key in
   `artifacts/resupply-api/src/lib/app-config/validators.ts` (e.g. a prefix or E.164/URL pattern).
   The read API returns `formatValid` and the UI shows a non-blocking
   "format looks unexpected" warning — it never rejects a save, so keep
   patterns lenient. `validators.test.ts` pins every rule key to the
   catalog.

## Finding a setting

The page has a filter box (matches label / env-var key / category), a
"configured N of M" summary, and an **Only unset** toggle so an operator
can quickly find what still needs a value. Each category card shows its
own configured/total count.

## Caveats

- **ElevenLabs** synthesises patient-facing speech (PHI); it is covered by
  the executed ElevenLabs BAA.
- **SendGrid From address** stays fixed at `info@pennpaps.com` (the "One
  From address" hard rule); only the display name is editable here.
- Migration 0211 has not been baselined into production's migration
  ledger by this change. It applies via the normal deploy migrator
  (`RUN_DB_MIGRATIONS=true`) or Supabase tooling like any other
  hand-written SQL migration.
