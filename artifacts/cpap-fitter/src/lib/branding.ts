// Live, host-resolved storefront branding for the customer-facing site.
//
// Centralized so the header, hero, and footer all render the SAME tenant
// identity. The constants below are compile-time fallbacks that ship with
// the static SPA bundle, so the first paint never waits on the network. The
// fallback is the **platform** identity (CareMetric Breathe) — NOT any one
// tenant — so a brand-new or unconfigured tenant never flashes another
// tenant's brand. At runtime the module fetches GET /api/storefront-branding
// once (host-resolved on the server: a verified custom domain returns that
// tenant's brand — e.g. pennpaps.com → Penn Home Medical Supply) and components using
// `useStorefrontBranding()` re-render with the live values. A fetch failure
// just leaves the platform fallback in place.
//
// Mirrors the pattern in lib/contact.ts (company contact details).

import { useSyncExternalStore } from "react";

/**
 * The platform/parent-product brand. `PennFit` is only the repository
 * codename and `Penn Home Medical Supply` is one tenant operating on the platform — when
 * the software refers to *itself* (the admin workstation chrome, the SaaS
 * product name) it is always **CareMetric Breathe**. Mirrors the
 * server-side `PLATFORM_NAME` in
 * `artifacts/resupply-api/src/lib/company-info.ts`. Tenant-specific
 * surfaces use the host-resolved `storefrontName` instead.
 */
export const PLATFORM_NAME = "CareMetric Breathe";

/**
 * The platform's own logo, served as a static public asset (so it works
 * root-relative on every tenant host). Used as the logo fallback wherever a
 * tenant has not supplied its own `logoUrl` — the storefront header/footer
 * and the auth pages. A tenant with its own brand sets `organizations.logo_url`
 * (the Penn tenant points at its bundled `/penn/…` asset), which the
 * host-resolved branding returns and which takes precedence over this.
 */
export const PLATFORM_LOGO_URL = "/breathe/caremetric-logo.png";

/**
 * The platform's square app icon — the SAME artwork as
 * `PLATFORM_LOGO_URL` minus the "CareMetric AI" wordmark that the full
 * lockup bakes in underneath. Use this (not the lockup) in small square
 * brand slots that set the brand text separately, such as the admin
 * workstation chrome: squished into a ~36px box the lockup's wordmark
 * turns illegible and collides with the name rendered beside it. The
 * `/breathe/*` marketing pages inline the same path for the same reason.
 */
export const PLATFORM_ICON_URL = "/breathe/caremetric-icon.png";

export interface StorefrontBranding {
  /** Short customer-facing brand shown in the header/hero. */
  storefrontName: string;
  /** Registered/legal company name (footer "by …" line, copyright). */
  legalName: string;
  /** One-line storefront strapline. */
  tagline: string;
  /** Public URL of the tenant's logo, or null to use the bundled default. */
  logoUrl: string | null;
  /**
   * Whether these values are the host-resolved tenant brand (true) or the
   * bundled compile-time fallback (false, before the fetch lands / if it
   * fails). The bundled default is the **platform** identity (CareMetric
   * Breathe), so it is safe on any tenant's host. The SHARED admin chrome
   * still uses this flag to show a tenant-neutral label until the
   * host-resolved tenant name arrives.
   */
  resolved: boolean;
}

// Platform default — NOT a tenant. A host that resolves to a real tenant
// (e.g. pennpaps.com → Penn Home Medical Supply) overrides every field at runtime via the
// host-resolved fetch; an unconfigured/new tenant keeps this CareMetric
// identity. `logoUrl: null` falls back to PLATFORM_LOGO_URL at the render
// site (storefront header/footer + auth pages).
export const DEFAULT_BRANDING: StorefrontBranding = {
  storefrontName: "CareMetric Breathe",
  legalName: "CareMetric Breathe",
  tagline: "Your CPAP, made simple. Fit. Order. Resupply.",
  logoUrl: null,
  resolved: false,
};

let current: StorefrontBranding = DEFAULT_BRANDING;
const listeners = new Set<() => void>();
let fetchStarted = false;

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function startBrandingFetch(): void {
  if (fetchStarted || typeof window === "undefined") return;
  fetchStarted = true;
  void fetch("/api/storefront-branding", {
    headers: { Accept: "application/json" },
  })
    .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
    .then((data) => {
      if (!data || typeof data !== "object") return;
      const d = data as Record<string, unknown>;
      const next: StorefrontBranding = {
        storefrontName: nonEmpty(d.storefrontName)
          ? d.storefrontName
          : current.storefrontName,
        legalName: nonEmpty(d.legalName) ? d.legalName : current.legalName,
        tagline: nonEmpty(d.tagline) ? d.tagline : current.tagline,
        logoUrl: nonEmpty(d.logoUrl) ? d.logoUrl : null,
        // The fetch landed — this is the host-resolved brand now, even when
        // the values happen to equal the bundled default (the Penn host).
        resolved: true,
      };
      const changed = (
        Object.keys(next) as Array<keyof StorefrontBranding>
      ).some((k) => next[k] !== current[k]);
      if (!changed) return;
      current = next;
      for (const notify of listeners) notify();
    })
    .catch(() => {
      // Offline / API down — the bundled fallbacks stay in place.
    });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

const getSnapshot = (): StorefrontBranding => current;
const getServerSnapshot = (): StorefrontBranding => DEFAULT_BRANDING;

/**
 * The live storefront branding: the resolved tenant's identity once it has
 * loaded, the bundled fallbacks until then (or if the fetch fails).
 * Triggers the one-time fetch on first use.
 */
export function useStorefrontBranding(): StorefrontBranding {
  startBrandingFetch();
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Non-hook accessor for non-React call sites. */
export function getStorefrontBranding(): StorefrontBranding {
  startBrandingFetch();
  return current;
}

/**
 * Whether the tenant's storefront brand is a genuinely DIFFERENT name
 * from its registered company name.
 *
 * Surfaces that show both — the header lockup's "by <company>" line, the
 * footer brand block, the home hero's "<brand> is the online storefront
 * from <company>" — must gate the second name on this. A tenant that
 * trades under its registered name has the two fields equal (Penn Home
 * Medical Supply, since migration 0510 retired its "PennPaps" storefront
 * DBA), and rendering both unconditionally reads as "X by X".
 */
export function hasDistinctStorefrontName(b: StorefrontBranding): boolean {
  return areDistinctCompanyNames(b.storefrontName, b.legalName);
}

/**
 * Whether two company-name strings are genuinely different names, ignoring
 * surrounding whitespace and casing. Either side being blank counts as "not
 * distinct" — there is no second name to show.
 *
 * The single normalization every surface that prints two names must share.
 * `terms.tsx` compares `CompanyContact` fields rather than
 * `StorefrontBranding`, and a case-only difference there used to render
 * "Terms of service for Acme and acme" while the header and footer
 * correctly suppressed the duplicate.
 */
export function areDistinctCompanyNames(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.length > 0 && right.length > 0 && left !== right;
}
