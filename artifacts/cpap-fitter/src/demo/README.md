# Demo mode (client-side sandbox)

A self-contained, client-only "demo" of the entire storefront, account
area, fit flow, and admin console. When demo mode is on, a `window.fetch`
interceptor answers every same-origin API call (`/api/*`,
`/resupply-api/*`) from in-browser fixtures instead of the real backend.
Nothing is persisted server-side and no real PHI is ever involved.

New users can explore the whole site without an account or a running
backend, and toggle between demo and live at any time.

## How it works

```
main.tsx
  └─ resolveDemoActive()      ← lightweight flag check (no fixtures pulled)
        └─ if active: await import("./demo/boot")   ← LAZY, demo-only chunk
              └─ install.ts   ← replaces window.fetch
                    └─ router.ts   ← dispatches API calls to handlers/*
                          └─ handlers/*  ← Responses built from fixtures/*
  └─ then: await import("./App")   ← imported AFTER the optional demo boot
App.tsx
  └─ <DemoModeProvider>      ← reactive isDemo + enter/exit
        └─ <DemoBanner/>     ← status bar (on) / dismissible invite (off)
```

The demo sandbox is **code-split**: its router pulls in hundreds of
seeded routes/fixtures, so it is loaded lazily — `main.tsx` only
`import("./demo/boot")`s when `resolveDemoActive()` is true, and Vite
emits it as a separate chunk. Live storefront/admin traffic never
downloads or parses it.

Why the boot must run before `<App>`: the auth client binds
`globalThis.fetch` at module-load time
(`lib/resupply-auth-react/src/client.ts`). The interceptor has to be in
place before that happens — so `<App>` is imported **dynamically, after**
the optional demo boot. The wrapper checks the demo flag at **call**
time, so it stays a no-op passthrough in live mode and toggling needs no
re-install. (`DemoModeProvider`/`DemoBanner`, imported by `<App>`, are
small and depend only on the dependency-light `./state` module — not on
the router/fixtures.)

## Turning it on

- Click **Start demo** in the invite banner, or
- visit any URL with `?demo=1` (shareable deep link), or
- call `setDemoActive(true)` / `reloadIntoMode(true)` from `./state`.

`?demo=0` (or **Exit to live site**) turns it off. The flag is persisted
in `localStorage` (`pennfit:demo-mode:v1`). Toggling reloads the current
page so React Query caches and the in-memory store reset cleanly.

## Extending it

1. **Add a fixture** in `fixtures/` (match the shape the UI reads — the
   real response interfaces live in `src/lib/*` and the generated
   clients under `lib/api-client-react/src/{storefront,admin}/generated`).
2. **Add a handler** to the relevant `handlers/*.ts` with
   `route(method, "/path/with/:params", (req, params) => json(...))`.
   Handlers are matched first-match-wins in the order listed in
   `router.ts`.
3. For interactive writes that should stick within a session, route
   through a mutable, reload-scoped store — `fixtures/store.ts` for the
   storefront/account surfaces, or the per-domain stores in
   `fixtures/platform.ts`, `fixtures/fitting.ts` and
   `fixtures/referrals.ts`.

Anything you don't explicitly handle falls back to a benign default
(empty object for GETs, `{ ok: true }` for mutations) so unmocked
endpoints render empty states rather than erroring.

**That fallback is also the trap.** A page with no seeded routes still
renders — it just renders EMPTY, and nothing fails to tell you. So when
you add a surface, add a test that asserts it is genuinely seeded (see
`platform-console.test.ts`); "the page loads" is not evidence that the
demo covers it.

## Admin surface coverage

The two admin consoles are seeded end to end, actions included:

- **Super-admin (`/platform/*`)** — every console page: fleet dashboard
  (analytics, margin, health, overview), tenant directory and detail
  (create / suspend / reactivate / impersonate, per-tenant feature flags,
  admins, usage, activity), billing, global integrations, the operator
  roster, the support queue, outreach (contacts + campaigns), vendor cost
  rates, connection tests, and the launch checklist. Fixtures in
  `fixtures/platform.ts`, routes in `handlers/platform.ts`.
- **Tenant (`/admin/*`)** — the long tail lives in `handlers/ext0`–`ext16`
  plus the domain modules; `handlers/fitting-referrals.ts` covers the mask
  catalog, formulary, fit sessions, safety screens, provider referrals and
  the AI referral triage queue.

The demo stores model real cause and effect across pages, which is what
makes the consoles demonstrable rather than merely populated. For example:
clearing the SendGrid credential on **Global integrations** turns the
matching vendor dot dark on the **Dashboard** and makes the **email
connection test** report `not_configured`; adding a deny rule on
**Formulary** changes what the simulator allows; signing off a size band on
the **Mask catalog** clears its review flag and records the provenance
cited.

## Tests

- `state.test.ts` — URL/localStorage flag resolution + subscriptions.
- `router.test.ts` — dispatch + fallbacks for the key surfaces.
- `install.test.ts` — passthrough when off, intercept when on.
- `platform-console.test.ts` — the super-admin console and the tenant
  fitting/referral pages are seeded (not silently falling through to the
  empty fallback), and their write paths are reflected by the next read.
- `empty.drift.test.ts` — the empty fallback seeds every array-typed key
  the SPA's response types declare, so an unseeded page renders its empty
  state instead of crashing.
