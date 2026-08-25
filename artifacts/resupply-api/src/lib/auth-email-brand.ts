// Per-request brand for the OUTWARD-FACING auth emails.
//
// The auth router is mounted three times and the correct brand differs per
// mount, because the audiences do:
//
//   * `/api/auth` — a PATIENT on a tenant's storefront. One bundle serves
//     every tenant, so a static name welcomed them to "CareMetric Breathe", a
//     product they have never heard of.
//   * `/api/provider/auth` — a PROVIDER a tenant's staff invited to e-sign
//     that tenant's patients' documents. Their invite already names the
//     tenant (`<storefront> Provider Portal`, routes/admin/provider-esign.ts),
//     so a password reset naming the PLATFORM instead was the same account
//     addressed by two different brands. On a security-sensitive email that
//     is not just untidy: an unrecognised sender is what recipients are
//     trained to treat as phishing.
//   * `/resupply-api/auth` — STAFF in the console. Stays platform-branded and
//     uses neither resolver: the console chrome already says CareMetric
//     Breathe, and that mail fires before a tenant is resolved.
//
// Lives here rather than inline in `app.ts` so the resolvers are nameable and
// testable: the auth router only sees an opaque function, and the interesting
// behavior (which host resolves to which brand, and what an unclaimed host
// does) deserves assertions of its own. See CLAUDE.md's brand architecture.

import type { AuthBrandResolver } from "@workspace/resupply-auth";

import { requestHost } from "./request-host";
import { resolveBrandingByHost } from "./tenant-branding";

/**
 * The tenant branding for the host this request arrived on.
 *
 * Uses `resolveBrandingByHost` — NOT `resolveOrgIdByHost` +
 * `resolveBrandingByOrgId`. The two resolvers in `tenant-branding.ts` answer
 * deliberately different questions and fall back differently, and only one of
 * them is safe here:
 *
 *   * `resolveOrgIdByHost` answers "whose DATA does this request operate on",
 *     so an unmatched host, an unbound domain, or a lookup error all resolve
 *     to the SEED org — the single-tenant-correct answer for data access.
 *   * `resolveBrandingByHost` answers "what does this host LOOK like", so the
 *     same cases resolve to the PLATFORM brand.
 *
 * Routing a branding question through the data resolver would have rendered
 * the seed tenant's name — today, Penn Home Medical Supply — into auth email
 * sent from the platform's own host, from any unclaimed domain, and from
 * every host during a lookup blip. That is the cross-tenant leak this whole
 * area exists to prevent, so the branding resolver is the only correct input.
 *
 * Never throws: an unresolved host yields the platform brand, which is
 * exactly what each mount's static default already is.
 */
async function brandForRequest(
  req: Parameters<AuthBrandResolver>[0],
): Promise<{ storefrontName: string; legalName: string }> {
  const brand = await resolveBrandingByHost(requestHost(req));
  return { storefrontName: brand.storefrontName, legalName: brand.legalName };
}

/** Patient storefront (`/api/auth`) — the tenant's own brand, unadorned. */
export const storefrontAuthBrandResolver: AuthBrandResolver = async (req) => {
  const { storefrontName, legalName } = await brandForRequest(req);
  return { productName: storefrontName, signatureName: legalName };
};

/**
 * Provider e-signature portal (`/api/provider/auth`).
 *
 * Keeps the `"<brand> Provider Portal"` shape the static mount option had,
 * because the suffix is doing work: a provider may hold accounts with several
 * DMEs, and "reset your <tenant> password" alone would not say WHICH surface.
 *
 * The wording mirrors the INVITE at `routes/admin/provider-esign.ts` exactly
 * — same `<storefrontName> Provider Portal` product name, same
 * `legalName || storefrontName` signature — so the two emails a provider
 * receives about one account agree. Provider links are built from
 * `resolveTenantBaseUrl(orgId) ?? publicBaseUrl`, so a tenant with a verified
 * domain lands them on its host and this resolves; a tenant without one has
 * no host to be identified by and correctly keeps the platform name.
 */
export const providerPortalAuthBrandResolver: AuthBrandResolver = async (
  req,
) => {
  const { storefrontName, legalName } = await brandForRequest(req);
  return {
    productName: `${storefrontName} Provider Portal`,
    signatureName: legalName || storefrontName,
  };
};
