// Hand-rolled fetch wrapper for /admin/today.
// Aggregate worklist endpoint that returns the top items across the
// queues a CSR touches every day. See routes/admin/today.ts for shape
// notes.

export interface TodayConversation {
  id: string;
  channel: string;
  last_message_at: string | null;
  patient_id: string | null;
  customer_id: string | null;
  assigned_admin_user_id: string | null;
}

export interface TodayFollowup {
  id: string;
  due_at: string;
  body: string;
  patient_id: string | null;
  customer_id: string | null;
  source: "patient" | "shop_customer";
}

export interface TodayReturn {
  id: string;
  status: string;
  reason: string;
  customer_id: string;
  created_at: string;
}

export interface TodayComplianceAlert {
  id: string;
  alert_type: "low_usage" | "no_response" | "send_failure" | "manual";
  severity: "info" | "warning" | "critical";
  summary: string;
  patient_id: string;
  status: "open" | "snoozed" | "resolved";
  created_at: string;
}

export interface TodayRxRenewal {
  id: string;
  patient_id: string;
  item_sku: string;
  hcpcs_code: string | null;
  valid_until: string;
}

export interface TodayDocument {
  id: string;
  document_type: string;
  patient_id: string;
  filename: string;
  created_at: string;
}

export interface TodayResponse {
  serverTime: string;
  conversationsAwaitingReply: TodayConversation[];
  overdueFollowups: TodayFollowup[];
  pendingReturns: TodayReturn[];
  complianceAlerts: TodayComplianceAlert[];
  rxRenewalsDue: TodayRxRenewal[];
  documentsToReview: TodayDocument[];
}

export async function fetchTodayWorklist(): Promise<TodayResponse> {
  const res = await fetch("/resupply-api/admin/today", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load today's worklist (${res.status})`);
  }
  return (await res.json()) as TodayResponse;
}
