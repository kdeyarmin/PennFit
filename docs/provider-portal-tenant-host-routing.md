# Provider portal multi-tenant host routing

Status: **Slices 1–3 + tenant honesty chrome shipped** — membership deep
links, session-pinned `provider_active_org_id` for platform-host PHI,
platform-host chrome to re-select the active DME, and tenant-host
deep-links to _other_ verified portals. Brand host still wins; seed
soft-fallback never returns for PHI lists.

## Problem

Provider list/count and RTM PHI routes used to resolve the tenant via
`resolveOrgIdByHost`, which soft-falls to the **seed** org on the platform
host (`cmbreathe.com`, Railway public domain, unbound hosts). That meant a
signed-in provider hitting the platform host could see the seed tenant's
signature queue pending counts and RTM caseload — cross-tenant PHI leak
under multi-tenant deployments.

## Shipped posture

| Surface                              | Resolver                                   | Missing host tenant / pin                                    |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| `GET /api/provider/me` pending count | `resolveProviderTenantOrgId` (brand → pin) | **403** `provider_tenant_host_required`                      |
| `GET /api/provider/queue` list       | same                                       | **403**                                                      |
| RTM (`attachProviderOrgId`)          | same                                       | **403**                                                      |
| SPA `/provider/*` gate               | reads error code / platform host           | **WrongTenantHost** — select (session pin) and/or deep links |
| SPA `ProviderShell` (platform)       | `isPlatformHomeHost` + `orgs.length > 1`   | `<select>` re-pins via `POST /orgs/select`                   |
| SPA `ProviderShell` (tenant)         | other verified `portalUrl`s ≠ current host | Deep-link chrome only (re-sign-in on other domain)           |
| `GET /api/provider/orgs`             | session `provider_id` only                 | Works on platform host; names + portal URLs + `activeOrgId`  |
| `POST /api/provider/orgs/select`     | CSRF + active `provider_dme_links`         | Pins `sessions.provider_active_org_id` (migration 0533)      |
| Admin invite                         | `resolveProviderPortalBaseUrl`             | **422** `tenant_domain_required` + Company Information link  |
| Single-doc view / sign / batch       | row-owned by `provider_id`                 | unchanged                                                    |

### Resolve order (`resolveProviderTenantOrgId`)

1. **Brand host** (verified custom domain / tenant subdomain) always wins.
2. Else **session pin** if `provider_active_org_id` is set and the provider
   still has an active `provider_dme_links` row (stale pins are cleared).
3. Else **null** → 403. Never seed-org soft-fallback.

`provider_active_org_id` is distinct from admin `impersonated_org_id` —
admin gates must not read it.

On a **tenant brand host**, changing the session pin does **not** change
PHI (brand wins). Cross-tenant switching there requires navigating to the
other practice's verified `portalUrl` (host-only session cookie → expect
re-sign-in). Platform host uses the in-SPA `<select>`; tenant hosts show
deep-link chrome only.

## Remaining

1. Ops: enable `BILLING_PAYWALL_ENFORCED` in prod when ready (runbook).

## Non-goals

- Do not reintroduce seed soft-fallback for PHI list routes.
- Do not scope row-owned referral signing by host (that 404'd cross-tenant
  referral orders — migration 0487).
- Do not reuse `impersonated_org_id` for provider active-org.
