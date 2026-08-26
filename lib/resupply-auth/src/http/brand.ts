// Per-request brand resolution for outbound auth email.
//
// The two auth emails a PATIENT receives — verify-your-email on sign-up and
// the password-reset link — are sent from a bundle that serves every tenant's
// storefront. A static `productName` therefore named the platform on a
// tenant's own site: someone signing up at a tenant's domain was welcomed to
// "CareMetric Breathe", a product they have never heard of, moments after
// handing that tenant their details.
//
// The lib stays brand-neutral and DB-free: the host tenant injects a
// resolver, and this module only decides when to trust what it returns.
//
// Fail-soft is the whole point. A verification link the recipient never gets
// blocks sign-up, and a reset link that never arrives locks someone out of
// their account — so a branding lookup must never be able to stop the send.
// Every failure mode (no resolver, a throw, a timeout inside the resolver, a
// blank name) falls back to the static option the mount was configured with,
// which is always a correct-if-generic name.

import type { Request } from "express";

/** The brand fields an auth email renders. */
export interface AuthEmailBrand {
  productName: string;
  signatureName?: string;
  /**
   * Optional absolute origin for links in the email (verified tenant
   * custom domain). When omitted, the mount's `deps.publicBaseUrl` is used.
   */
  publicBaseUrl?: string;
}

/**
 * Resolve the brand for one request — typically from its Host, which is what
 * identifies the tenant whose storefront the user is actually on.
 *
 * Return `null` (or a blank `productName`) to defer to the mount's static
 * option. Implementations should not throw, but this module tolerates it.
 */
export type AuthBrandResolver = (
  req: Request,
) => Promise<AuthEmailBrand | null> | AuthEmailBrand | null;

export interface AuthBrandOptions {
  productName: string;
  signatureName?: string;
  resolveBrand?: AuthBrandResolver;
}

function clean(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function staticBrand(options: AuthBrandOptions): AuthEmailBrand {
  return {
    productName: options.productName,
    ...(options.signatureName !== undefined
      ? { signatureName: options.signatureName }
      : {}),
  };
}

/**
 * The brand to render into this request's auth email: the resolver's answer
 * when it gives a usable one, else the mount's static option.
 *
 * `signatureName` is taken from the resolver ONLY when the resolver also
 * supplied a product name — mixing a resolved tenant wordmark with the
 * platform's signature (or the reverse) would sign one brand's email with
 * another's name. The two travel together or not at all.
 */
export async function resolveAuthEmailBrand(
  options: AuthBrandOptions,
  req: Request,
): Promise<AuthEmailBrand> {
  if (!options.resolveBrand) return staticBrand(options);
  let resolved: AuthEmailBrand | null;
  try {
    resolved = await options.resolveBrand(req);
  } catch {
    return staticBrand(options);
  }
  const productName = clean(resolved?.productName);
  if (!productName) return staticBrand(options);
  const signatureName = clean(resolved?.signatureName);
  const publicBaseUrl = clean(resolved?.publicBaseUrl);
  return {
    productName,
    ...(signatureName !== undefined ? { signatureName } : {}),
    ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
  };
}
