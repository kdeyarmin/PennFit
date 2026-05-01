// Hand-rolled fetch wrappers for the operations center page.

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
  scanned?: number;
  sent?: number;
  skippedNoConfig?: number;
  skippedFailed?: number;
  skippedOptOut?: number;
  sendgridConfigured?: boolean;
}

export async function runAbandonedCartDispatcher(): Promise<DispatcherResult> {
  return await postDispatcher("/resupply-api/admin/shop/abandoned-carts/send-due");
}

export async function runReviewRequestDispatcher(): Promise<DispatcherResult> {
  return await postDispatcher("/resupply-api/admin/shop/review-requests/send-due");
}

async function postDispatcher(url: string): Promise<DispatcherResult> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(json?.message ?? json?.error ?? `Dispatcher failed (${res.status})`);
  }
  return (await res.json()) as DispatcherResult;
}
