// Hand-rolled fetch wrapper for /admin/delivery-failures.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

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
  counts: { messageFailures: number; auditFailures: number };
  failureStatuses: readonly string[];
  messageEvents: MessageFailureEvent[];
  auditEvents: AuditFailureEvent[];
}

export async function fetchDeliveryFailures(
  sinceDays = 14,
): Promise<DeliveryFailuresResponse> {
  const res = await fetch(
    `/resupply-api/admin/delivery-failures?sinceDays=${sinceDays}`,
    { headers: { Accept: "application/json", ...(await authHeaders()) } },
  );
  if (!res.ok) throw new Error(`Failed to load failures (${res.status})`);
  return (await res.json()) as DeliveryFailuresResponse;
}
