# Edge header hardening — strip client `X-Forwarded-Host`

**Why:** multi-tenant resolution keys off the request host
(`requestHost()` → `resolveOrgIdByHost`), which prefers Express's
trust-proxy-aware `req.hostname`. Express derives `req.hostname` from
`X-Forwarded-Host` whenever the immediate connection peer is trusted, and
`createTrustProxyFn()` (`artifacts/resupply-api/src/lib/trusted-proxies.ts`)
trusts hop 0 unconditionally — because on Railway the socket peer is always
the platform's internal load balancer, never the client. So the app **cannot**
distinguish an edge-set `X-Forwarded-Host` from a client-forged one on its own.

If a client-supplied `X-Forwarded-Host` reaches Express, a request aimed at one
tenant's domain can set `X-Forwarded-Host: <another-registered-tenant-domain>`
and have leads/orders filed under — or outbound mail branded as — that victim
tenant. (Bound: the host only resolves to a tenant if it matches a **registered**
custom domain, and host selects which tenant a request _writes/brands as_, not
which tenant's data it can _read_. So this is write-misattribution /
branding-spoof, not cross-tenant disclosure.)

The fix is at the **edge**, not in app code: ensure only the trusted edge can
set `X-Forwarded-Host`, by removing any inbound copy of the header before it is
forwarded to the origin.

## Cloudflare (custom domains: `cmbreathe.com`, `pennpaps.com`, tenant domains)

Add a **Transform Rule → Modify Request Header** that removes the header on all
incoming requests:

- Rules → Transform Rules → **Modify Request Header** → Create rule
- **If**: `Hostname` matches the proxied custom domains (or "All incoming
  requests")
- **Then**: **Remove** header `X-Forwarded-Host`
- Deploy.

Cloudflare evaluates this on the _inbound_ request, so a client-sent
`X-Forwarded-Host` is dropped before Cloudflare forwards to origin. Cloudflare
forwards the real requested host in the standard `Host` header; Railway's proxy
then re-derives `X-Forwarded-Host` from that `Host` for the origin, so legitimate
proxied traffic is unaffected and `req.hostname` resolves to the genuine host.

## Railway

Railway's proxy sets `X-Forwarded-*` for the real connection. Confirm it does
**not** pass through a client-supplied `X-Forwarded-Host` ahead of its own value.
If Railway ever exposes a header-stripping option, also strip inbound
`X-Forwarded-Host` there as defense-in-depth (belt-and-suspenders with the
Cloudflare rule above).

## Verify

After deploying the Cloudflare rule, from an external client:

```bash
# Spoof attempt: the forged header must NOT change tenant resolution.
curl -s -H 'X-Forwarded-Host: some-other-tenant.example' \
  https://pennpaps.com/api/storefront-branding | jq '.brandName, .host'
# Expect the PennPaps tenant branding, NOT some-other-tenant's.
```

The host-resolution path itself is covered by
`artifacts/resupply-api/src/lib/request-host.test.ts` and the tenant-host
integration tests; this runbook covers the edge layer those tests assume.

## Do NOT "fix" this in app code

Do not change `createTrustProxyFn()` to validate hop 0 against the proxy CIDRs.
The immediate peer is Railway's internal LB (not a Cloudflare CIDR), so that
predicate would reject it, breaking `req.ip` real-client resolution and
custom-domain routing — without actually being reachable by an external client.
See the inline comment in `trusted-proxies.ts` and the "Host-header → tenant
spoofing" note in [`threat_model.md`](../../threat_model.md).
