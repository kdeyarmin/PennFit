// Live, host-resolved storefront branding for the customer-facing site.
//
// Centralized so the header, hero, and footer all render the SAME tenant
// identity. The constants below are compile-time fallbacks that ship with
// the static SPA bundle, so the first paint never waits on the network and
// the canonical PennPaps site looks identical to before. At runtime the
// module fetches GET /api/storefront-branding once (host-resolved on the
// server: a verified custom domain returns that tenant's brand) and
// components using `useStorefrontBranding()` re-render with the live
// values. A fetch failure just leaves the fallbacks in place.
//
// Mirrors the pattern in lib/contact.ts (company contact details).

import { useSyncExternalStore } from "react";

/**
 * The platform/parent-product brand. `PennFit` is only the repository
 * codename and `PennPaps` is one tenant operating on the platform — when
 * the software refers to *itself* (the admin workstation chrome, the SaaS
 * product name) it is always **CareMetric Breathe**. Mirrors the
 * server-side `PLATFORM_NAME` in
 * `artifacts/resupply-api/src/lib/company-info.ts`. Tenant-specific
 * surfaces use the host-resolved `storefrontName` instead.
 */
export const PLATFORM_NAME = "CareMetric Breathe";

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
   * fails). The storefront ignores this — its bundled default IS the Penn
   * tenant's brand. The SHARED admin chrome uses it to avoid showing one
   * tenant's name (the "PennPaps" fallback) on another tenant's host until
   * branding resolves: it renders a tenant-neutral label while `false`.
   */
  resolved: boolean;
  /**
   * True when this host is the PLATFORM home (cmbreathe.com / the Railway
   * host) rather than a tenant storefront. The router renders the CareMetric
   * Breathe marketing page at `/` when this is true. Seeded synchronously
   * from the hostname so the platform domain doesn't flash a tenant
   * storefront before the branding fetch confirms it; the fetch then sets
   * the authoritative value from the server.
   */
  isPlatform: boolean;
}

/**
 * Synchronous, best-effort guess of whether the current host is the platform
 * home — used only to seed the first paint so cmbreathe.com doesn't briefly
 * show a tenant storefront. The server's `isPlatform` is authoritative and
 * overrides this once the branding fetch lands. Matches ONLY the platform
 * apex hosts (never a `<slug>.cmbreathe.com` tenant subdomain), so a tenant
 * host never gets a wrong platform guess.
 */
function guessPlatformHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "cmbreathe.com" ||
    host === "www.cmbreathe.com" ||
    host.endsWith(".up.railway.app")
  );
}

export const DEFAULT_BRANDING: StorefrontBranding = {
  storefrontName: "PennPaps",
  legalName: "Penn Home Medical Supply",
  tagline: "Your CPAP, made simple. Fit. Shop. Resupply.",
  logoUrl: null,
  resolved: false,
  isPlatform: false,
};

let current: StorefrontBranding = {
  ...DEFAULT_BRANDING,
  isPlatform: guessPlatformHost(),
};
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
        // Authoritative platform flag from the server (overrides the
        // hostname guess used for the first paint).
        isPlatform:
          typeof d.isPlatform === "boolean" ? d.isPlatform : current.isPlatform,
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
