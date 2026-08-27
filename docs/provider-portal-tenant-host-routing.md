# Provider portal multi-tenant host routing

Status: **Slice 2 shipped** — session-pinned `provider_active_org_id` lets
queue/RTM run on the platform host under a membership-validated org. Brand
host still wins; seed soft-fallback never returns for PHI lists.

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

## Remaining

1. **In-SPA org switcher** on tenant hosts for multi-linked providers
   (chrome while already on a brand host).
2. Ops: enable `BILLING_PAYWALL_ENFORCED` in prod when ready (runbook).

## Non-goals

- Do not reintroduce seed soft-fallback for PHI list routes.
- Do not scope row-owned referral signing by host (that 404'd cross-tenant
  referral orders — migration 0487).
- Do not reuse `impersonated_org_id` for provider active-org.
