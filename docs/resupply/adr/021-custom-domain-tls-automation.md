# ADR 021 — Automating per-tenant TLS / edge binding for custom domains

**Status**: Proposed (design-first; no code in this change)
**Date**: 2026-06-15
**Supersedes**: none
**Related**: the per-tenant storefront-branding + custom-domain feature
(PR #847), [`docs/runbooks/tenant-custom-domain.md`](../../runbooks/tenant-custom-domain.md),
[`docs/railway-hosting-review-2026-05-29.md`](../../railway-hosting-review-2026-05-29.md)
(Cloudflare-in-front edge posture).

## Context

Multi-tenant Phase 3 shipped per-tenant custom domains: a tenant binds a
domain in **Settings → Storefront branding**, the app issues a DNS **TXT
ownership challenge** (`_pennfit-verify.<domain>`), and on a successful
`POST /resupply-api/admin/storefront-branding/domain/verify` the host is
marked `verified`. From then on:

- the public branding resolver (`lib/tenant-branding.ts`) serves that
  tenant's brand for requests on the host, and
- the verified host is added to the CORS allowlist (cached / background-
  refreshed).

**The gap this ADR addresses.** Verifying ownership does **not** provision
TLS. Today an operator must still, _per domain_, bind the hostname on the
edge so HTTPS terminates — add the custom domain in Railway (Let's Encrypt)
or proxy it through Cloudflare with a covering cert. Until that happens the
domain "verifies" in-app but browsers can't reach it over HTTPS (the UI
even says "TLS provisioning may take a few minutes"). That manual step is
fine at one or two tenants; it becomes the onboarding bottleneck — and a
silent failure mode — as the tenant count grows. The one-command
`tenant:onboard` (PR #865) and self-serve branding made every _other_ step
hands-off; edge binding is the last human in the loop.

Production is already fronted by **Cloudflare** (CLAUDE.md; hosting review
R7), which is the relevant fact for the decision below.

## Decision (proposed)

Adopt **Cloudflare for SaaS — Custom Hostnames** as the automation path,
wired into the existing verify flow and **feature-flagged + fail-soft** so
it degrades to today's manual operator step when unconfigured.

### 1. The flow

1. Tenant adds a domain (unchanged). The CNAME target shown in the UI
   becomes the Cloudflare **fallback hostname** (e.g. `ssl.pennpaps.com`)
   when automation is enabled, instead of `RAILWAY_PUBLIC_DOMAIN`. This is
   already an env-overridable value (`PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET`),
   so no UI change is required beyond pointing that variable at the
   fallback hostname.
2. On **verify** — after our `_pennfit-verify` TXT check passes — the app
   additionally calls Cloudflare's **Custom Hostnames API**
   (`POST /zones/{zone_id}/custom_hostnames`) to register the hostname for
   the SaaS zone. Cloudflare then issues and **auto-renews** the
   certificate and routes the hostname to the configured fallback origin
   (our Railway service).
3. The app records Cloudflare's returned custom-hostname **status**
   (`pending` → `active`) and reflects it back to the admin page so the
   tenant sees "certificate issuing → live" without an operator touching
   anything.

### 2. Ownership: keep our TXT gate, let Cloudflare validate for the cert

We keep the app's `_pennfit-verify` TXT challenge as the **product**
ownership gate (provider-agnostic, already built and tested). Cloudflare
performs its **own** hostname pre-validation for cert issuance (TXT or HTTP
method). The implementation should prefer Cloudflare's **TXT** validation
method and surface that record alongside ours, OR adopt Cloudflare's
delegated validation — to be decided in implementation. Net UX: at most one
extra DNS record beyond the CNAME, shown in the same instructions panel.

### 3. Configuration (new, all optional / feature-gated)

| Variable                             | Purpose                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`               | Scoped token: **SSL and Certificates: Edit** + **Custom Hostnames: Edit** on the SaaS zone only. Nothing broader. |
| `CLOUDFLARE_ZONE_ID`                 | The zone that owns the fallback hostname.                                                                         |
| `PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET` | Repointed at the Cloudflare fallback hostname (already exists).                                                   |

Gate behind a feature flag (`domains.tls_automation`, seeded **OFF**) **and**
the presence of the CF env. When either is absent the verify route behaves
exactly as it does today (mark `verified`; manual operator step per the
runbook). This mirrors the established "feature-gated, fail-soft" posture
of the integrations layer and the storage/SendGrid/voice vendors.

### 4. Failure posture (load-bearing)

- A Cloudflare API error at verify time **must not** fail the tenant's
  verify or take the request down. We mark the domain `verified` (ownership
  is proven) and record the TLS provisioning as `pending`/`failed` for a
  retry + an operator notice — never a 500.
- The Custom Hostnames call is **idempotent** per hostname (create-or-get),
  so a retry or a re-verify can't double-register.
- Removing a domain (`DELETE …/domain`) should best-effort **delete** the
  Cloudflare custom hostname so we don't leak certs/hostnames; failure is
  logged, not fatal (same shape as the best-effort logo-object cleanup).

### 5. Where it hooks in (code touchpoints, for the implementing PR)

- `artifacts/resupply-api/src/routes/admin/storefront-branding.ts` —
  the `…/domain/verify` and `DELETE …/domain` handlers gain the
  feature-gated Cloudflare calls.
- A new vendor adapter, e.g. `lib/resupply-integrations-cloudflare/`
  (pure, `read…ConfigOrNull()` + `availability()`, no DB imports), to keep
  the SDK/HTTP surface out of the route — symmetric with the other
  integration adapters.
- `artifacts/resupply-api/src/lib/tenant-domain.ts` — instructions builder
  extended to include the Cloudflare validation record when automation is
  on.
- Schema: likely a small additive migration adding a `custom_domain_tls`
  status (`none|pending|active|failed`) + a Cloudflare custom-hostname id
  on `organizations`, so the UI can show provisioning state distinctly from
  ownership state. (Deferred to the implementation PR; noted here so the
  schema impact is visible.)
- Docs: fold the "operator-side step" of
  `docs/runbooks/tenant-custom-domain.md` into "automatic when
  `domains.tls_automation` is on; manual otherwise."

## Consequences

### Positive

- Per-domain operator work drops to ~zero: cert issuance + renewal + edge
  routing become an API call the app already makes at verify time.
- Reuses the **existing** Cloudflare edge (no new infra to run), and the
  existing TXT-verify flow and CNAME-target plumbing.
- Fail-soft + flag-gated: shipping it changes nothing until the CF env +
  flag are set; a CF outage degrades to the current manual step, never a
  broken verify.
- Certificates auto-renew (no per-tenant expiry to track).

### Negative / Trade-offs

- **Cost / plan**: Cloudflare for SaaS (Custom Hostnames) is a paid
  add-on; per-hostname pricing applies. A business decision, not just an
  engineering one.
- **Token blast radius**: a long-lived `CLOUDFLARE_API_TOKEN` with
  cert/hostname edit on the zone is a new high-value secret. Mitigation:
  minimum scopes, zone-restricted, rotatable, stored in Railway secrets
  (never in `app_config` catalog as plaintext).
- **Vendor coupling** to Cloudflare for the automated path. Mitigated by
  the adapter boundary and by keeping the manual path as the permanent
  fallback, so we're never _unable_ to onboard a domain without CF.
- **New async failure mode**: cert issuance is eventually-consistent
  (`pending` → `active`), so the UI must show provisioning state and the
  system should reconcile (poll or webhook) rather than assume instant TLS.
- **Plan limits**: Custom Hostname counts are bounded per plan tier; high
  tenant volume needs the right tier.

## Alternatives considered

- **Railway custom-domains API** — programmatically add the domain to the
  service (Let's Encrypt). Simpler and no extra vendor, but Railway custom
  domains are not designed for SaaS-scale (per-service domain limits) and
  there's no first-class "custom hostname" abstraction. Fine for a handful
  of tenants; doesn't scale to a fleet. Rejected as the primary path.
- **Caddy / on-demand TLS proxy** in front of the app — a reverse proxy
  issues Let's Encrypt certs per hostname on first request, gated by an
  "is this a verified tenant domain?" ask-endpoint. Fully automated and
  vendor-neutral, but adds a proxy layer we have to **run and operate**
  (the service-boot contract is deliberately minimal; CLAUDE.md / ADR 010
  "no Docker, no Redis"). Rejected to avoid new always-on infra.
- **Status quo (manual per-domain)** — keep the documented operator step.
  Correct at low volume; the explicit reason this ADR exists is that it
  doesn't scale and is a silent-failure surface.
- **A different edge (Fastly, AWS CloudFront + ACM, etc.)** — all can do
  SaaS custom hostnames, but production already runs Cloudflare; switching
  edges for this one feature is unjustified churn.

## Open questions for the implementation PR

1. Validation method: adopt Cloudflare's TXT validation and drop our
   `_pennfit-verify` record, or keep ours as the product gate and add
   Cloudflare's separately? (Leaning: keep ours, add CF's — provider-
   agnostic ownership.)
2. Reconciliation: poll Cloudflare custom-hostname status on a pg-boss job,
   or consume a Cloudflare webhook? (Leaning: a light poll on the existing
   worker, since hostname counts are low and webhooks add surface.)
3. Exact schema for TLS state on `organizations` (see §5).
4. Cloudflare for SaaS plan + budget sign-off (business).

## References

- PR #847 — per-tenant storefront branding + custom-domain wiring
- PR #865 — `tenant:onboard` (one-command tenant setup)
- `docs/runbooks/tenant-custom-domain.md`
- `artifacts/resupply-api/src/routes/admin/storefront-branding.ts`
- `artifacts/resupply-api/src/lib/tenant-domain.ts`,
  `artifacts/resupply-api/src/lib/tenant-branding.ts`
- ADR 010 — no Docker, no Redis (minimal-infra principle)
- Cloudflare for SaaS — Custom Hostnames API
