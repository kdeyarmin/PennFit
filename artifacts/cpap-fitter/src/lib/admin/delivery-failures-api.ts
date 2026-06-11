// Hand-rolled fetch wrapper for /admin/delivery-failures.

import { ApiError } from "@workspace/api-client-react/admin";

export interface MessageFailureEvent {
  kind: "message";
  id: string;
  occurredAt: string;
  channel: "sms" | "voice" | "email" | null;
  direction: string;
  senderRole: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
  conversationId: string | null;
  patientId: string | null;
  patientName: string | null;
}

/** Recall-notification SMS delivery failure — stamped on
 *  `recall_notifications` by /sms/status-callback. Recall sends have no
 *  conversation thread; the drill-down handle is `recallId`. */
export interface RecallFailureEvent {
  kind: "recall";
  id: string;
  occurredAt: string;
  channel: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
  recallId: string;
  patientId: string;
  patientName: string | null;
}

export interface AuditFailureEvent {
  kind: "audit";
  id: string;
  occurredAt: string;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  actorEmail: string | null;
  metadata: Record<string, unknown> | null;
}

export interface DeliveryFailuresResponse {
  sinceDays: number;
  counts: {
    messageFailures: number;
    /** Optional for back-compat with API builds that predate the
     *  recall delivery-tracking stream. */
    recallFailures?: number;
    auditFailures: number | null;
  };
  failureStatuses: readonly string[];
  messageEvents: MessageFailureEvent[];
  /** Optional for back-compat — see counts.recallFailures. */
  recallEvents?: RecallFailureEvent[];
  auditEvents: AuditFailureEvent[];
  /** When true, the system-events stream is no longer tracked (the
   *  audit_log source was retired). UI surfaces this as a clear
   *  "no longer tracked" notice on the System events tab. */
  auditEventsUnavailable?: boolean;
}

export async function fetchDeliveryFailures(
  sinceDays = 14,
): Promise<DeliveryFailuresResponse> {
  const url = `/resupply-api/admin/delivery-failures?sinceDays=${sinceDays}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as DeliveryFailuresResponse;
}
