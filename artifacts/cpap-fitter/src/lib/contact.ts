// Customer-facing support contact details. Centralized so the
// floating chat launcher, footer contact column, and any inline
// "have a question?" links all stay in lockstep.
//
// The constants below are compile-time fallbacks that ship with the
// static SPA bundle, so the first paint never waits on the network.
// At runtime the module fetches GET /api/company-info once (the
// values the admin saved on /admin/company-information) and
// components using `useCompanyContact()` re-render with the live
// values. A fetch failure just leaves the fallbacks in place.

import { useSyncExternalStore } from "react";

/** Penn Home Medical Supply support phone, E.164-style for tel:
 *  links and dashed for display. */
export const SUPPORT_PHONE_E164 = "+18144710627";
export const SUPPORT_PHONE_DISPLAY = "(814) 471-0627";

/** Customer-service mailbox. Distinct from info@pennpaps.com which
 *  is the legal/privacy contact. */
export const SUPPORT_EMAIL = "support@pennpaps.com";

/** Business hours blurb. Plain English, displayed under the phone
 *  in the footer + floating launcher. */
export const SUPPORT_HOURS = "Mon–Fri 9a–5p ET";

export interface CompanyContact {
  name: string;
  phoneE164: string;
  phoneDisplay: string;
  email: string;
  /** Legal/privacy contact mailbox (the privacy policy + terms pages). */
  generalEmail: string;
  hours: string;
}

export const DEFAULT_COMPANY_CONTACT: CompanyContact = {
  name: "PennPaps",
  phoneE164: SUPPORT_PHONE_E164,
  phoneDisplay: SUPPORT_PHONE_DISPLAY,
  email: SUPPORT_EMAIL,
  generalEmail: "info@pennpaps.com",
  hours: SUPPORT_HOURS,
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
  void fetch("/api/company-info", {
    headers: { Accept: "application/json" },
  })
    .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
    .then((data) => {
      if (!data || typeof data !== "object") return;
      const d = data as Record<string, unknown>;
      const next: CompanyContact = {
        name: nonEmpty(d.name) ? d.name : current.name,
        phoneE164: nonEmpty(d.phoneE164) ? d.phoneE164 : current.phoneE164,
        phoneDisplay: nonEmpty(d.phoneDisplay)
          ? d.phoneDisplay
          : current.phoneDisplay,
        email: nonEmpty(d.supportEmail) ? d.supportEmail : current.email,
        generalEmail: nonEmpty(d.generalEmail)
          ? d.generalEmail
          : current.generalEmail,
        hours: nonEmpty(d.supportHours) ? d.supportHours : current.hours,
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
