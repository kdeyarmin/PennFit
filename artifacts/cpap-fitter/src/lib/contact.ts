// Customer-facing support contact details. Centralized so the
// floating chat launcher, footer contact column, and any inline
// "have a question?" links all stay in lockstep.
//
// The constants below are compile-time fallbacks that ship with the
// static SPA bundle, so the first paint never waits on the network.
// At runtime the module fetches GET /api/storefront-company-info once
// (the values the admin saved on /admin/company-information) and
// publishes them to every subscriber. If that path 404s (rolling
// deploy: new SPA + API that has not yet remounted the alias), it
// falls back to GET /api/company-info — same handler once both are
// live. A total fetch failure just leaves the fallbacks in place.

import { useSyncExternalStore } from "react";

// These compile-time fallbacks ship in the tenant-AGNOSTIC SPA bundle, so
// they must be the neutral PLATFORM identity (CareMetric Breathe), never the
// seed tenant's (Penn Home Medical Supply) — otherwise every tenant's first paint would flash
// Penn's brand/phone before /api/company-info resolves the real tenant. The
// platform has no patient support phone, so the phone fallback is blank until
// the tenant's own number loads.
export const SUPPORT_PHONE_E164 = "";
export const SUPPORT_PHONE_DISPLAY = "";

/** Platform support mailbox fallback (the live tenant value loads at runtime). */
export const SUPPORT_EMAIL = "support@cmbreathe.com";

/** Business hours blurb. Plain English, displayed under the phone
 *  in the footer + floating launcher. */
export const SUPPORT_HOURS = "Mon–Fri 9a–5p ET";

/**
 * CareMetric platform defaults for the two in-app AI assistants. The
 * platform is CareMetric Breathe; Penn Home Medical Supply is one tenant
 * operating on it. A tenant owner can rename the assistants
 * from System Configuration; the live values arrive with /api/company-info.
 */
export const DEFAULT_STOREFRONT_ASSISTANT_NAME = "CareMetric Assistant";
export const DEFAULT_ADMIN_ASSISTANT_NAME = "CareMetric Copilot";

export interface CompanyContact {
  /** Storefront/brand display name (DBA when set, else legal name). */
  name: string;
  /** Registered legal company name (footer, legal pages "operated by …"). */
  legalName: string;
  phoneE164: string;
  phoneDisplay: string;
  email: string;
  /** Legal/privacy contact mailbox (the privacy policy + terms pages). */
  generalEmail: string;
  /** Public website URL (storefront domain), or null when unset. */
  websiteUrl: string | null;
  hours: string;
  /** Tenant-configurable name of the storefront chat assistant. */
  assistantStorefrontName: string;
  /** Tenant-configurable name of the admin-console assistant. */
  assistantAdminName: string;
}

// Neutral PLATFORM identity (CareMetric Breathe). Not the seed tenant — the
// bundle is shared across every tenant host, and the live tenant values
// arrive with /api/company-info.
export const DEFAULT_COMPANY_CONTACT: CompanyContact = {
  name: "CareMetric Breathe",
  legalName: "CareMetric Breathe",
  phoneE164: SUPPORT_PHONE_E164,
  phoneDisplay: SUPPORT_PHONE_DISPLAY,
  email: SUPPORT_EMAIL,
  generalEmail: "support@cmbreathe.com",
  websiteUrl: null,
  hours: SUPPORT_HOURS,
  assistantStorefrontName: DEFAULT_STOREFRONT_ASSISTANT_NAME,
  assistantAdminName: DEFAULT_ADMIN_ASSISTANT_NAME,
};

let current: CompanyContact = DEFAULT_COMPANY_CONTACT;
const listeners = new Set<() => void>();
let fetchStarted = false;

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function startCompanyContactFetch(): void {
  if (fetchStarted || typeof window === "undefined") return;
  fetchStarted = true;
  const headers = { Accept: "application/json" };
  const opts: RequestInit = { headers, cache: "no-store" };
  void fetch("/api/storefront-company-info", opts)
    .then(async (res) => {
      if (res.ok) return res.json() as Promise<unknown>;
      // Alias missing on an older API build — fall back to the
      // historical path so a rolling deploy does not leave the
      // storefront stuck on CareMetric compile-time defaults.
      const legacy = await fetch("/api/company-info", opts);
      return legacy.ok ? (legacy.json() as Promise<unknown>) : null;
    })
    .then((data) => {
      if (!data || typeof data !== "object") return;
      const d = data as Record<string, unknown>;
      const next: CompanyContact = {
        name: nonEmpty(d.name) ? d.name : current.name,
        legalName: nonEmpty(d.legalName) ? d.legalName : current.legalName,
        phoneE164: nonEmpty(d.phoneE164) ? d.phoneE164 : current.phoneE164,
        phoneDisplay: nonEmpty(d.phoneDisplay)
          ? d.phoneDisplay
          : current.phoneDisplay,
        email: nonEmpty(d.supportEmail) ? d.supportEmail : current.email,
        generalEmail: nonEmpty(d.generalEmail)
          ? d.generalEmail
          : current.generalEmail,
        websiteUrl: nonEmpty(d.websiteUrl) ? d.websiteUrl : current.websiteUrl,
        hours: nonEmpty(d.supportHours) ? d.supportHours : current.hours,
        assistantStorefrontName: nonEmpty(d.assistantStorefrontName)
          ? d.assistantStorefrontName
          : current.assistantStorefrontName,
        assistantAdminName: nonEmpty(d.assistantAdminName)
          ? d.assistantAdminName
          : current.assistantAdminName,
      };
      const changed = (Object.keys(next) as Array<keyof CompanyContact>).some(
        (k) => next[k] !== current[k],
      );
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

const getSnapshot = (): CompanyContact => current;
const getServerSnapshot = (): CompanyContact => DEFAULT_COMPANY_CONTACT;

/**
 * The live support contact details: the admin-saved company info once
 * it has loaded, the bundled fallbacks until then (or if the fetch
 * fails). Triggers the one-time fetch on first use.
 */
export function useCompanyContact(): CompanyContact {
  startCompanyContactFetch();
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Non-hook variant for class components (the error boundary) and
 * non-React call sites. Returns the latest snapshot without
 * subscribing — callers won't re-render when the fetch lands.
 */
export function getCompanyContact(): CompanyContact {
  startCompanyContactFetch();
  return current;
}
