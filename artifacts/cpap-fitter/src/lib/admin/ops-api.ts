// Hand-rolled fetch wrappers for the operations center page.
//
// Auth flows over the `pf_session` cookie, sent automatically by
// the browser on same-origin requests.

import { ApiError } from "@workspace/api-client-react/admin";
import { csrfHeader } from "../csrf";

export interface OpsStatus {
  // Mirrors the server contract (/admin/ops-status). `twilioFax` is
  // returned by the API and typed here for fidelity even though the
  // current VendorStrip renders a curated subset (no fax tile yet).
  vendors: {
    sendgrid: boolean;
    twilioVoice: boolean;
    twilioSms: boolean;
    twilioFax: boolean;
    stripe: boolean;
    objectStorage: boolean;
  };
  /**
   * Per-vendor: the credential was saved in System Configuration
   * (/admin/system/configuration) but hasn't been folded into the live
   * process yet — catalog keys are `applyMode: "restart"`, so they take
   * effect on the next deploy. When true, `vendors[key]` is also true
   * (the value exists); the UI renders a distinct "saved — applies after
   * restart" state instead of a green "configured" or amber "not
   * configured". Optional so older API responses still typecheck.
   */
  vendorsPendingRestart?: {
    sendgrid: boolean;
    twilioVoice: boolean;
    twilioSms: boolean;
    twilioFax: boolean;
    stripe: boolean;
    objectStorage: boolean;
  };
  dispatchers: {
    abandonedCart: { eligibleNow: number };
    reviewRequest: { eligibleNow: number };
    /** Phase G.12 — channel-agnostic count (email + SMS share
     *  the same renewal_requested_at stamp). */
    rxRenewal?: { eligibleNow: number };
    /** Phase G.12 — channel-agnostic count (both channels share
     *  sent_at on patient_smart_trigger_events). */
    smartTrigger?: { eligibleNow: number };
  };
  /** Phase G.16 — non-dispatcher queues that ops needs visibility
   *  into (today: physician-fax-outreach pending until the vendor
   *  adapter ships). Optional so older API responses still
   *  typecheck. */
  queues?: {
    faxOutreachPending?: { count: number };
  };
  team: {
    activeAdmins: number;
    activeAgents: number;
    pendingInvites: number;
  };
  serverTime: string;
}

export async function fetchOpsStatus(): Promise<OpsStatus> {
  const url = "/resupply-api/admin/ops-status";
  const res = await fetch(url, {
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
  return (await res.json()) as OpsStatus;
}

export interface DispatcherResult {
  // Standard dispatcher fields (cart-abandonment, review-request)
  scanned?: number;
  sent?: number;
  skippedNoConfig?: number;
  skippedFailed?: number;
  skippedOptOut?: number;
  sendgridConfigured?: boolean;
  // Channel dispatcher fields (Rx renewal, smart-trigger send-due)
  attempted?: number;
  failed?: number;
  skippedNoContact?: number;
  /** Backwards-compatible alias for skippedNoContact on the email channel.
   *  Not displayed in ResultPanel — skippedNoContact already covers it. */
  skippedNoEmail?: number;
  /** Backwards-compatible alias for skippedNoContact on the SMS channel.
   *  Not displayed in ResultPanel — skippedNoContact already covers it. */
  skippedNoPhone?: number;
  remaining?: number;
  windowDays?: number;
  channel?: string;
  // Evaluator fields (smart-trigger evaluate)
  proposed?: number;
  inserted?: number;
  skippedExisting?: number;
}

export async function runAbandonedCartDispatcher(): Promise<DispatcherResult> {
  return await postDispatcher(
    "/resupply-api/admin/shop/abandoned-carts/send-due",
  );
}

export async function runReviewRequestDispatcher(): Promise<DispatcherResult> {
  return await postDispatcher(
    "/resupply-api/admin/shop/review-requests/send-due",
  );
}

/**
 * Phase G.11 — Rx-renewal concierge (Phase B.2 / SMS variant Phase G.3).
 * Channel-parameterized: ops console renders one button per channel.
 */
export async function runRxRenewalDispatcher(
  channel: "email" | "sms",
): Promise<DispatcherResult> {
  return await postDispatcher(
    `/resupply-api/admin/prescriptions/send-renewal-due?channel=${channel}`,
  );
}

/**
 * Phase G.11 — smart-trigger nudge (Phase E.2 / SMS variant Phase G.7).
 * Two endpoints, two channels:
 *   * /admin/smart-triggers/evaluate scans therapy data for new triggers.
 *   * /admin/smart-triggers/send-due dispatches the nudge for unsent ones.
 * The ops console exposes both with separate buttons so an operator can
 * either re-evaluate (cheap, idempotent on a partial-unique index) or
 * send-due in isolation.
 */
export async function runSmartTriggerEvaluator(): Promise<DispatcherResult> {
  return await postDispatcher("/resupply-api/admin/smart-triggers/evaluate");
}

export async function runSmartTriggerDispatcher(
  channel: "email" | "sms",
): Promise<DispatcherResult> {
  return await postDispatcher(
    `/resupply-api/admin/smart-triggers/send-due?channel=${channel}`,
  );
}

async function postDispatcher(url: string): Promise<DispatcherResult> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", ...csrfHeader() },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(res, data, { method: "POST", url });
  }
  return (await res.json()) as DispatcherResult;
}
