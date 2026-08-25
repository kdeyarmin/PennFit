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
// (which host resolves to which brand, and what happens when the lookup
// fails) deserves assertions of its own.
//
// Only the patient mount uses this. The staff console and the provider portal
// stay on the platform identity — that mail is the software's own, and it
// fires before a tenant is resolved. See CLAUDE.md's brand architecture.

import type { AuthBrandResolver } from "@workspace/resupply-auth";

import { requestHost } from "./request-host";
import { resolveBrandingByOrgId, resolveOrgIdByHost } from "./tenant-branding";

/**
 * Resolve the storefront brand for the tenant whose host this request came
 * in on, or `null` to leave the auth router on its static platform default.
 *
 * `null` is the honest answer for a request that resolves to no tenant — the
 * platform's own marketing site, or a domain that isn't bound. The router
 * treats it as "use the mount's configured name".
 *
 * Both resolvers are cached (~60s per org) and fail soft to the platform
 * brand on their own, so this adds no round-trip to a warm path and cannot
 * throw. That matters: the auth router's contract is that a branding lookup
 * must never be able to stop a verification or reset email from going out.
 */
export const storefrontAuthBrandResolver: AuthBrandResolver = async (req) => {
  const orgId = await resolveOrgIdByHost(requestHost(req));
  if (!orgId) return null;
  const brand = await resolveBrandingByOrgId(orgId);
  return {
    productName: brand.storefrontName,
    signatureName: brand.legalName,
  };
};
