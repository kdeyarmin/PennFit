// The demo sandbox's tenant identity — one source of truth.
//
// The public sandbox is the PLATFORM's showcase, not the Penn Home
// Medical Supply tenant. Penn's brand ("Penn Home Medical Supply",
// pennpaps.com, PennBot/PennPilot) is that ONE tenant's data
// and must never appear here: a prospect clicking "Start demo" from
// cmbreathe.com would otherwise be shown another customer's company as
// though it were the product.
//
// Every fixture that names the operating company, its domain, its staff,
// or its assistants resolves through these constants so the sandbox
// cannot drift back to a real tenant's brand one fixture at a time.
// `demo.brand.test.ts` fails the build if a Penn literal reappears under
// `src/demo/`.
//
// The domain is deliberately `demo.example` — `.example` is reserved by
// RFC 2606 and can never resolve, so no sandbox link or address can be
// mistaken for a live one. Contrast `scripts/src/seed-demo-tenant.ts`,
// which stands up a REAL demo tenant in the database with real,
// routable `@cmbreathe.com` credentials; that is a different demo (see
// that script's header) and the two must not be conflated.

/** Customer-facing brand shown in the storefront header/hero. */
export const DEMO_STOREFRONT_NAME = "CareMetric Breathe";

/** Registered company name for the sandbox's operating tenant. */
export const DEMO_LEGAL_NAME = "CareMetric Demo DME";

/** Legal-entity spelling, for company-information / document surfaces. */
export const DEMO_LEGAL_NAME_FULL = "CareMetric Demo DME, LLC";

/** Storefront strapline; matches lib/branding.ts's platform default. */
export const DEMO_TAGLINE = "Your CPAP, made simple. Fit. Order. Resupply.";

/** Non-routable host for every sandbox domain, link, and address. */
export const DEMO_DOMAIN = "demo.example";

/** Origin for signed links, invites, and storefront URLs in fixtures. */
export const DEMO_BASE_URL = `https://${DEMO_DOMAIN}`;

/** Platform logo, served from `/breathe/` (see lib/branding.ts). */
export const DEMO_LOGO_URL = "/breathe/caremetric-logo.png";

export const DEMO_SUPPORT_EMAIL = `support@${DEMO_DOMAIN}`;
export const DEMO_GENERAL_EMAIL = `info@${DEMO_DOMAIN}`;
export const DEMO_BILLING_EMAIL = `billing@${DEMO_DOMAIN}`;
export const DEMO_OWNER_EMAIL = `owner@${DEMO_DOMAIN}`;

/**
 * The two in-app assistants, at their CareMetric platform defaults. A
 * tenant may rename them (RESUPPLY_ASSISTANT_STOREFRONT_NAME /
 * RESUPPLY_ASSISTANT_ADMIN_NAME); "PennBot"/"PennPilot" are the Penn
 * tenant's chosen names and are not the sandbox's to display.
 */
export const DEMO_ASSISTANT_STOREFRONT_NAME = "CareMetric Assistant";
export const DEMO_ASSISTANT_ADMIN_NAME = "CareMetric Copilot";

/** A sandbox staff mailbox, e.g. `demoStaffEmail("demo.csr")`. */
export function demoStaffEmail(local: string): string {
  return `${local}@${DEMO_DOMAIN}`;
}
