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

export interface StorefrontBranding {
  /** Short customer-facing brand shown in the header/hero. */
  storefrontName: string;
  /** Registered/legal company name (footer "by …" line, copyright). */
  legalName: string;
  /** One-line storefront strapline. */
  tagline: string;
  /** Public URL of the tenant's logo, or null to use the bundled default. */
  logoUrl: string | null;
}

export const DEFAULT_BRANDING: StorefrontBranding = {
  storefrontName: "PennPaps",
  legalName: "Penn Home Medical Supply",
  tagline: "Your CPAP, made simple. Fit. Shop. Resupply.",
  logoUrl: null,
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
