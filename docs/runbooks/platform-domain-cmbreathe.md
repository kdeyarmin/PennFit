# Runbook: bringing up the platform domain `cmbreathe.com`

How to wire the platform homepage domain (`cmbreathe.com`) through
Cloudflare + Railway, and keep `pennpaps.com` routing only to the Penn
Home Medical Supply tenant. This is the operator-side counterpart to
[`tenant-custom-domain.md`](./tenant-custom-domain.md) (which covers a
**tenant** binding its own host); here the domain is the **platform
apex**, not a tenant-claimable custom domain.

## Brand architecture recap (why these two domains differ)

- **`cmbreathe.com`** is the **platform / home** domain. A request to the
  bare apex falls back to the platform brand **"CareMetric Breathe"**
  (`DEFAULT_BRANDING` in `artifacts/resupply-api/src/lib/tenant-branding.ts`).
  It is **reserved** — the domain normalizer rejects it as a tenant custom
  domain (`artifacts/resupply-api/src/lib/tenant-domain.ts`), and it is the
  default
  `PLATFORM_SUBDOMAIN_BASES` value, so `<slug>.cmbreathe.com` routes to
  the tenant whose `organizations.slug = <slug>`.
- **`pennpaps.com`** is the **Penn Home Medical Supply tenant's** verified
  custom domain, seeded permanently for the `penn-home-medical` org by
  migration `0353_platform_and_pennpaps_domains.sql`. A unique index on
  `organizations.custom_domain` means no other tenant can claim it. Requests
  on this host resolve to the Penn org and render the **"PennPaps"** brand.

No code change is required to add `cmbreathe.com` — the application already
treats it as the platform apex. The steps below are DNS + Railway + env: the
CORS allowlist, plus pinning the public base URL **before** binding so the
tenant's outbound links don't silently follow `RAILWAY_PUBLIC_DOMAIN` to the
new host (Step 2).

## Steps

### 1. Cloudflare DNS for `cmbreathe.com`

In the `cmbreathe.com` zone, point the host at the Railway service:

- **Apex** `cmbreathe.com` → `CNAME` to the Railway host
  (`pennfit.up.railway.app`), **proxied** (orange cloud). Cloudflare
  flattens the apex CNAME automatically.
- **`www`** → `CNAME` to `cmbreathe.com` (proxied), or a redirect rule to
  the apex — pick one and keep it consistent.

Keep the edge settings from
[`railway-hosting-review-2026-05-29.md`](../railway-hosting-review-2026-05-29.md)
R7:

- **Browser Cache TTL → "Respect Existing Headers"** so the app's
  `immutable` `/assets/` caching reaches browsers.
- Confirm `trust proxy` / `req.ip` still resolves the real client through
  the extra Cloudflare hop (see
  [`verify-xff-chain.md`](./verify-xff-chain.md)). Cloudflare's published
  ranges are already trusted in
  `artifacts/resupply-api/src/lib/trusted-proxies.ts`.

### 2. Bind the domain on Railway

**Prerequisite — pin the public base URL first.** Binding a custom domain can
change `RAILWAY_PUBLIC_DOMAIN` to `cmbreathe.com`, and when `PUBLIC_BASE_URL`
is unset the boot-time `applyEnvAliases()`
(`lib/resupply-secrets/src/env-aliases.ts`) synthesizes the five
`*_PUBLIC_BASE_URL` vars (`SHOP_`, `REMINDER_`, `RESUPPLY_VOICE_`,
`RESUPPLY_DASHBOARD_`, `PENN_ADMIN_`) from it. So if those are left blank, the
PennPaps tenant's reminder / shop / admin / voice links would silently move to
`cmbreathe.com`. Before binding, set **`PUBLIC_BASE_URL=https://pennpaps.com`**
(or pin each `*_PUBLIC_BASE_URL` var) so the tenant's outbound links stay on
`pennpaps.com`. An explicit value always wins over the `RAILWAY_PUBLIC_DOMAIN`
fallback.

Add `cmbreathe.com` (and `www.cmbreathe.com` if you serve it) under the
production service's **Settings → Domains**. Publish **exactly** the DNS
records Railway shows — typically a CNAME, and any **TXT ownership record**
Railway displays — into Cloudflare; with only the CNAME the domain can stay
inactive (or 404) even after DNS resolves. The CNAME target must match the
Cloudflare record from Step 1. Wait for Railway to report the domain
**Active** (it issues the cert once verified).

> Note: once a custom domain takes over, Railway may set
> `RAILWAY_PUBLIC_DOMAIN` to `cmbreathe.com`. Step 3 makes the CORS
> allowlist independent of whatever Railway puts there, and the
> `PUBLIC_BASE_URL` pin above keeps the tenant's link-building independent of
> it too.

### 3. Set `RESUPPLY_ALLOWED_ORIGINS`

On the production service, set the CORS allowlist explicitly to both public
hosts:

```
RESUPPLY_ALLOWED_ORIGINS=https://cmbreathe.com,https://www.cmbreathe.com,https://pennpaps.com
```

Why each entry:

- `cmbreathe.com` / `www.cmbreathe.com` — the platform apex is **not** a
  platform subdomain and **not** a verified custom domain, so it is only
  admitted to CORS when it appears here (or via `RAILWAY_PUBLIC_DOMAIN`).
  Same-origin requests work regardless, but listing it keeps credentialed /
  cross-origin calls clean and independent of Railway's env.
- `pennpaps.com` — already joins CORS **dynamically** as a verified custom
  domain (`isVerifiedCustomDomainOrigin`, cache warmed at boot), so this
  entry is belt-and-suspenders, not strictly required.

(CORS logic: `artifacts/resupply-api/src/app.ts`. Production fails closed if
both `RESUPPLY_ALLOWED_ORIGINS` and `RAILWAY_PUBLIC_DOMAIN` are empty.)

### 4. Verify after DNS propagates

Confirm the **API** is routed, not just the SPA:

```bash
pnpm --filter @workspace/scripts verify:deploy -- https://cmbreathe.com
```

Then load each host in a browser:

- `https://cmbreathe.com` → **CareMetric Breathe** platform brand.
- `https://pennpaps.com` → **PennPaps** (Penn Home Medical Supply).
- (optional) `https://<some-tenant-slug>.cmbreathe.com` → that tenant's
  brand via slug routing.

## Notes

- `pennpaps.com` needs the **same** Cloudflare-proxy + Railway custom-domain
  binding to actually terminate TLS and route to the app — the DB row
  (migration 0353) only decides _which tenant_ a reaching request resolves
  to, it does not front the host.
- To change the CNAME target shown to **future** tenants wiring up their own
  domains, set `PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET` (default:
  `RAILWAY_PUBLIC_DOMAIN`).
- For tenant-initiated custom domains and the Cloudflare-for-SaaS TLS
  automation, see [`tenant-custom-domain.md`](./tenant-custom-domain.md).
