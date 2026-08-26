import { resolveTenantLinkBaseUrl } from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

/** Platform storefront origin for patient-facing email deep links. */
export function platformPublicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

/**
 * Tenant-safe link origin for patient order / lifecycle emails.
 *
 * - Explicit override wins (tests / operator previews).
 * - No orgId → platform env (legacy single-tenant callers).
 * - orgId set → verified custom domain, or seed-only platform fallback;
 *   non-seed without a domain returns null (refuse cmbreathe.com links).
 */
export async function resolvePatientEmailLinkBase(
  orgId: string | undefined,
  baseUrlOverride?: string,
): Promise<string | null> {
  const platform = platformPublicBaseUrl(baseUrlOverride);
  if (baseUrlOverride?.trim()) return platform;
  if (!orgId?.trim()) return platform;
  return resolveTenantLinkBaseUrl(orgId, platform);
}

export const TENANT_DOMAIN_REQUIRED = "tenant_domain_required" as const;

/** True when a tenant-scoped email cfg has a safe click-link origin. */
export function isPatientEmailClickBaseReady(
  publicBaseUrl: string | undefined,
): boolean {
  return Boolean(publicBaseUrl?.trim());
}
