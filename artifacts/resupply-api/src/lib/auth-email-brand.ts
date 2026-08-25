// Per-request brand for the PATIENT-facing auth emails.
//
// The verify-your-email and password-reset messages sent from the `/api/auth`
// mount go to someone standing on a specific tenant's storefront, but one
// bundle serves them all — so the brand has to come from the request's Host,
// not from a constant chosen at mount time. Without this, a patient who
// signed up on a tenant's own domain was welcomed to "CareMetric Breathe", a
// product they have never heard of.
//
// Lives here rather than inline in `app.ts` so it is nameable and testable:
// the auth router only sees an opaque function, and the interesting behavior
// (which host resolves to which brand, and what an unclaimed host does)
// deserves assertions of its own.
//
// Only the patient mount uses this. The staff console and the provider portal
// stay on the platform identity — that mail is the software's own, and it
// fires before a tenant is resolved. See CLAUDE.md's brand architecture.

import type { AuthBrandResolver } from "@workspace/resupply-auth";

import { requestHost } from "./request-host";
import { resolveBrandingByHost } from "./tenant-branding";

/**
 * The storefront brand for the host this request arrived on.
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
 * Never throws and never returns null: an unresolved host yields the platform
 * brand, which is exactly what the mount's static default already is.
 */
export const storefrontAuthBrandResolver: AuthBrandResolver = async (req) => {
  const brand = await resolveBrandingByHost(requestHost(req));
  return {
    productName: brand.storefrontName,
    signatureName: brand.legalName,
  };
};
