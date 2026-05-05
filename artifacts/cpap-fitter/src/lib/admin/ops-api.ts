// Hand-rolled fetch wrappers for the operations center page.
//
// Auth flows over the `pf_session` cookie, sent automatically by
// the browser on same-origin requests.

export interface OpsStatus {
  vendors: {
    sendgrid: boolean;
    twilioVoice: boolean;
    twilioSms: boolean;
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
  team: {
    activeAdmins: number;
    activeAgents: number;
    pendingInvites: number;
  };
  serverTime: string;
}

export async function fetchOpsStatus(): Promise<OpsStatus> {
  const res = await fetch("/resupply-api/admin/ops-status", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load ops status (${res.status})`);
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
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      json?.message ?? json?.error ?? `Dispatcher failed (${res.status})`,
    );
  }
  return (await res.json()) as DispatcherResult;
}
