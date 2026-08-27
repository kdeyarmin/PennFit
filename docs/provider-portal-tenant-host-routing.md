# Provider portal multi-tenant host routing

Status: **deferred-backlog complete** for host fail-closed + SPA honesty.
Full multi-org membership / org-picker remains a **separate epic** (not a
deferred-review leftover).

## Problem

Provider list/count and RTM PHI routes used to resolve the tenant via
`resolveOrgIdByHost`, which soft-falls to the **seed** org on the platform
host (`cmbreathe.com`, Railway public domain, unbound hosts). That meant a
signed-in provider hitting the platform host could see the seed tenant's
signature queue pending counts and RTM caseload — cross-tenant PHI leak
under multi-tenant deployments.

## Shipped posture

| Surface                              | Resolver                         | Missing host tenant                                         |
| ------------------------------------ | -------------------------------- | ----------------------------------------------------------- |
| `GET /api/provider/me` pending count | `resolveBrandOrgIdByHost`        | **403** `provider_tenant_host_required`                     |
| `GET /api/provider/queue` list       | same                             | **403**                                                     |
| RTM (`attachProviderOrgId`)          | same                             | **403**                                                     |
| SPA `/provider/*` gate               | reads error code / platform host | **WrongTenantHost** card (not "No portal access")           |
| Admin invite                         | `resolveProviderPortalBaseUrl`   | **422** `tenant_domain_required` + Company Information link |
| Single-doc view / sign / batch       | row-owned by `provider_id`       | unchanged                                                   |

Providers must use the tenant's **verified custom domain** (or active tenant
subdomain), e.g. `pennpaps.com` for Penn Home Medical Supply — not the
platform host.

## Future epic (out of deferred backlog)

1. **Provider ↔ org membership session.** `provider_dme_links` already
   authorizes referrals; queue/RTM still need an explicit active-org session
   (not host-only) plus CSRF-safe org switching.
2. **Org picker / deep links** on a platform-hosted provider SPA.
3. Keep fail-closed on platform host until (1)–(2) ship — do not reintroduce
   seed soft-fallback for PHI list routes.

## Non-goals

- Do not reintroduce seed soft-fallback for PHI list routes.
- Do not scope row-owned referral signing by host (that 404'd cross-tenant
  referral orders — migration 0487).
