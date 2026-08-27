# Provider portal multi-tenant host routing

Status: **partially shipped** (fail-closed on platform host). Full multi-org
provider membership / org-picker remains future work.

## Problem

Provider list/count and RTM PHI routes used to resolve the tenant via
`resolveOrgIdByHost`, which soft-falls to the **seed** org on the platform
host (`cmbreathe.com`, Railway public domain, unbound hosts). That meant a
signed-in provider hitting the platform host could see the seed tenant's
signature queue pending counts and RTM caseload — cross-tenant PHI leak
under multi-tenant deployments.

## Shipped posture (round nine)

| Surface | Resolver | Missing host tenant |
| ------- | -------- | ------------------- |
| `GET /api/provider/me` pending count | `resolveBrandOrgIdByHost` | **403** `provider_tenant_host_required` |
| `GET /api/provider/queue` list | same | **403** |
| RTM (`attachProviderOrgId`) | same | **403** |
| Single-doc view / sign / batch | row-owned by `provider_id` | unchanged (no host soft-fallback) |

Providers must use the tenant's **verified custom domain** (or active tenant
subdomain), e.g. `pennpaps.com` for Penn Home Medical Supply — not the
platform host.

## Still open (product / architecture)

1. **Provider ↔ org membership.** Today a provider account is global; host
   picks the tenant for queue browse / RTM. A physician who works with
   several DMEs still relies on which portal domain they open (plus
   row-owned sign for referral orders staged under another org).
2. **Org picker / deep links.** A platform-hosted provider SPA that lists
   memberships and switches `org_id` without custom domains.
3. **DNS / onboarding checklist.** Document for operators: verify custom
   domain before inviting providers; platform host intentionally refuses
   queue/RTM.

## Non-goals

- Do not reintroduce seed soft-fallback for PHI list routes.
- Do not scope row-owned referral signing by host (that 404'd cross-tenant
  referral orders — migration 0487).
