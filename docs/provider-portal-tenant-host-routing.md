# Provider portal multi-tenant host routing

Status: **deferred-backlog complete** for host fail-closed + SPA honesty.
**Slice 1 of the multi-org epic shipped:** platform-host membership deep
links (`GET /api/provider/orgs` + WrongTenantHost picker). Session-pinned
active-org for platform-hosted PHI remains a **future slice**.

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
| SPA `/provider/*` gate               | reads error code / platform host | **WrongTenantHost** card with membership deep links         |
| `GET /api/provider/orgs`             | session `provider_id` only       | Works on platform host; names + portal URLs, **no PHI**     |
| Admin invite                         | `resolveProviderPortalBaseUrl`   | **422** `tenant_domain_required` + Company Information link |
| Single-doc view / sign / batch       | row-owned by `provider_id`       | unchanged                                                   |

Providers must use the tenant's **verified custom domain** (or active tenant
subdomain), e.g. `pennpaps.com` for Penn Home Medical Supply — not the
platform host. On the platform host, WrongTenantHost lists linked DMEs and
deep-links to each verified `/provider` URL.

## Future epic (remaining)

1. **Provider ↔ org membership session.** Explicit active-org on the
   session (not host-only) plus CSRF-safe org switching, so queue/RTM can
   run on the platform host under a membership-validated org.
2. **In-SPA org switcher** on tenant hosts for multi-linked providers.
3. Keep fail-closed on platform host for PHI lists until (1) ships — do
   not reintroduce seed soft-fallback for PHI list routes.

## Non-goals

- Do not reintroduce seed soft-fallback for PHI list routes.
- Do not scope row-owned referral signing by host (that 404'd cross-tenant
  referral orders — migration 0487).
