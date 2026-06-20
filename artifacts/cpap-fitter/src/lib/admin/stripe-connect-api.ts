// Typed fetch wrappers for tenant Stripe Connect (Express) onboarding
// (/admin/billing/stripe-connect/*). The backend creates an Express
// connected account, hands back a Stripe-hosted onboarding link, and gates
// live charge-routing on `chargesEnabled` (flipped by Stripe's
// `account.updated` webhook). See artifacts/resupply-api/src/routes/admin/
// stripe-connect.ts and lib/stripe/connect.ts.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

const BASE = "/resupply-api";

export interface StripeConnectStatus {
  /** True once an Express account id is stored on the org. */
  connected: boolean;
  /** True once Stripe has enabled charges (onboarding complete). Until
   *  then, charges keep routing to the platform account. */
  chargesEnabled: boolean;
  /** The `acct_…` id, or null when not connected. */
  accountId: string | null;
}

export interface StripeConnectStartResult {
  /** Stripe-hosted onboarding URL to redirect the owner to. */
  url: string;
  accountId: string;
}

async function getJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as T;
}

async function postJSON<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as T;
}

export const fetchStripeConnectStatus = () =>
  getJSON<StripeConnectStatus>("/admin/billing/stripe-connect/status");

/** Create (once) the Express account + return a fresh onboarding link. */
export const startStripeConnectOnboarding = () =>
  postJSON<StripeConnectStartResult>("/admin/billing/stripe-connect/start");

/** Reconcile `chargesEnabled` straight from Stripe (`accounts.retrieve`). */
export const refreshStripeConnectStatus = () =>
  postJSON<StripeConnectStatus>("/admin/billing/stripe-connect/refresh");

/** Detach the connected account (routes charges back to the platform). */
export const disconnectStripeConnect = () =>
  postJSON<StripeConnectStatus>("/admin/billing/stripe-connect/disconnect");
