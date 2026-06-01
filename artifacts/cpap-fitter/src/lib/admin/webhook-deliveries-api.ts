// Hand-rolled fetch wrappers for the outbound-webhook delivery worklist
// (Biller #37). The backend already exposes:
//
//   GET  /admin/webhook-deliveries?status=&subscriptionId=  (admin.tools.manage)
//   POST /admin/webhook-deliveries/:id/retry-now            (admin-only)
//
// The list returns delivery METADATA only — never the event payload
// (payloads can carry order PHI). We map the raw snake_case rows to the
// camelCase shape the rest of the SPA uses.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type WebhookDeliveryStatus =
  | "queued"
  | "delivered"
  | "failed"
  | "exhausted";

export interface WebhookDelivery {
  id: string;
  subscriptionId: string | null;
  eventType: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

interface RawWebhookDelivery {
  id: string;
  subscription_id: string | null;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempt_count: number | null;
  last_http_status: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    ...restInit,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

function mapDelivery(r: RawWebhookDelivery): WebhookDelivery {
  return {
    id: r.id,
    subscriptionId: r.subscription_id ?? null,
    eventType: r.event_type,
    status: r.status,
    attemptCount: r.attempt_count ?? 0,
    lastHttpStatus: r.last_http_status ?? null,
    lastError: r.last_error ?? null,
    nextAttemptAt: r.next_attempt_at ?? null,
    deliveredAt: r.delivered_at ?? null,
    createdAt: r.created_at,
  };
}

export async function listWebhookDeliveries(opts?: {
  status?: WebhookDeliveryStatus;
  subscriptionId?: string;
}): Promise<{ deliveries: WebhookDelivery[] }> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.subscriptionId) params.set("subscriptionId", opts.subscriptionId);
  const qs = params.toString();
  const { deliveries } = await jsonFetch<{ deliveries: RawWebhookDelivery[] }>(
    `/admin/webhook-deliveries${qs ? `?${qs}` : ""}`,
  );
  return { deliveries: (deliveries ?? []).map(mapDelivery) };
}

export function retryWebhookDelivery(
  id: string,
): Promise<{ ok: boolean; note?: string }> {
  return jsonFetch<{ ok: boolean; note?: string }>(
    `/admin/webhook-deliveries/${encodeURIComponent(id)}/retry-now`,
    { method: "POST" },
  );
}
