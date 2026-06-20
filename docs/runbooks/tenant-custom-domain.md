# Runbook: tenant storefront branding & custom domains

How a tenant brands their storefront and points their own domain at it,
and the one operator step the app can't do on its own (TLS/edge binding).

This is the first customer-facing slice of the multi-tenant work (see
[`docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md`](../multi-tenant-phase-0-engineering-plan-2026-06-14.md),
which reserved `organizations.slug` "for host / subdomain routing in
Phase 3").

## What ships in the app

Migration `0344_tenant_storefront_branding.sql` adds to
`resupply.organizations`:

| Column                                                   | Purpose                                                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `storefront_name`, `tagline`, `logo_url`                 | Customer-facing storefront identity.                      |
| `logo_object_path`                                       | Public-bucket key for the uploaded logo (replace/delete). |
| `custom_domain`                                          | The bound host (unique across tenants when set).          |
| `custom_domain_status` (`none` / `pending` / `verified`) | Domain lifecycle.                                         |
| `custom_domain_token`, `custom_domain_verified_at`       | DNS TXT ownership challenge state.                        |

The tenant admin page is **Settings → Storefront branding**
(`/admin/storefront-branding`, gated by `admin.tools.manage`). It lets a
tenant edit their storefront name / tagline, upload a logo, and bind +
verify a custom domain.

### How resolution works at runtime

- The SPA fetches `GET /api/storefront-branding` on first paint. The
  server resolves the request **Host**: a **verified** custom domain
  returns that tenant's brand; every other host returns the seed
  tenant's brand. So the canonical site is unchanged.
- A **verified** custom domain is automatically added to the CORS
  allowlist (cached, refreshed in the background) — no redeploy or
  `RESUPPLY_ALLOWED_ORIGINS` edit needed.

## Tenant-side steps (self-service, in the admin UI)

1. **Storefront identity** — set the storefront name + tagline, upload a
   logo (PNG/JPEG/WebP, ≤ 2 MB). Saved immediately; live on the next
   storefront page load (≤ 5 min edge cache).
2. **Add domain** — enter the domain (e.g. `shop.acme-dme.com`). The page
   shows two DNS records to publish:
   - a **CNAME** for the domain → the platform host, and
   - a **TXT** record (`_pennfit-verify.<domain>`) carrying a
     verification token.
3. **Publish the DNS records** at the tenant's DNS provider. For a
   root/apex domain, use the provider's ALIAS/ANAME or CNAME-flattening.
4. **Verify** — click _Verify domain_. The app resolves the TXT record;
   a match flips the domain to `verified`.

## TLS / edge binding — automated or manual

Proving DNS ownership (above) does **not** by itself provision TLS. There
are two modes:

### Automated (Cloudflare for SaaS — ADR 021)

When `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` are set **and** the
`domains.tls_automation` feature flag is ON, verifying a domain registers
it as a Cloudflare **custom hostname**; Cloudflare issues + **auto-renews**
the cert and routes the host to the origin — **no per-domain operator
step**. The tenant CNAMEs to the Cloudflare for SaaS **fallback hostname**
(set `PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET` to it), publishes the one TLS
validation TXT the page shows, and the branding page reflects the
certificate state (`Issuing… → HTTPS live`). One-time platform setup:
enable Cloudflare for SaaS on the zone, set the fallback origin, mint the
scoped token, flip the flag on. The flow is **fail-soft** — a Cloudflare
error never fails the tenant's verify; TLS shows `failed` and a re-verify
retries.

### Manual (default — flag off / Cloudflare unconfigured)

After a tenant verifies, the operator binds the host on the edge so HTTPS
terminates:

- **Railway:** add the custom domain under the service's **Settings →
  Domains** (Railway issues the cert and gives the CNAME target). The
  `cnameTarget` shown to the tenant defaults to `RAILWAY_PUBLIC_DOMAIN`;
  override it with `PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET` if you front the
  platform with a dedicated ingress hostname.
- **Cloudflare (current production):** add the hostname as a proxied
  record and ensure the origin cert covers it. Keep the existing edge
  settings from
  [`docs/railway-hosting-review-2026-05-29.md`](../railway-hosting-review-2026-05-29.md)
  R7 (Browser Cache TTL "Respect Existing Headers"; real `req.ip`).

Until the edge binding exists, the domain verifies in-app but browsers
can't reach it over HTTPS — which is why the UI says "TLS provisioning may
take a few minutes."

## Config / env

- `SUPABASE_STORAGE_BUCKET_PUBLIC` — public Supabase Storage bucket for
  logo uploads (same bucket the shop product images use). When unset, the
  logo upload endpoint returns `503 public_storage_not_configured` and the
  page tells the tenant logos aren't available in this environment;
  name/tagline still work. Create a **public** bucket in Supabase Studio →
  Storage and set this var.
- `PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET` — optional override for the CNAME
  target shown to tenants (default: `RAILWAY_PUBLIC_DOMAIN`).

## Safety notes

- Logo uploads are content-type allowlisted (PNG/JPEG/WebP) **and**
  magic-byte sniffed; **no SVG** (stored-XSS vector in a public bucket).
- A custom domain is unique across tenants (partial UNIQUE index +
  a friendly `409 domain_taken`); the normalizer rejects IPs, bare
  labels, `localhost`, and `*.up.railway.app` so a tenant can't claim a
  platform host.
- All branding/domain writes are scoped to the caller's tenant
  (`organizations.id = req.orgId`).
