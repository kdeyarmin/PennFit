// Hand-rolled fetch wrappers for the fitter follow-up alert worklist.
//
// Same rationale as fitter-requests-api.ts: this admin surface isn't in
// an OpenAPI spec, and a thin wrapper avoids a codegen cycle for every
// backend tweak.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

/**
 * The four ways a fitting goes quiet. The first three are the patient's
 * move; `request_unworked` is ours — they asked and nobody called back.
 */
export type FitterFollowupAlertType =
  | "fit_not_started"
  | "fit_abandoned"
  | "fit_no_request"
  | "request_unworked";

export type FitterFollowupAlertStatus = "open" | "resolved" | "dismissed";
export type FitterFollowupSeverity = "low" | "medium" | "high";

/**
 * Why the sweep closed an alert on its own. All five mean the patient
 * (or a CSR) actually acted — none of them is a human asserting it.
 */
export type FitterFollowupResolvedReason =
  | "fit_completed"
  | "request_received"
  | "dispensed"
  | "invite_revoked"
  | "request_worked";

export interface FitterFollowupContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** How this person asked (or was asked) to be reached. */
  preferredMethod: string;
  preferredTime: string | null;
}

export interface FitterFollowupAlertRow {
  id: string;
  alertType: FitterFollowupAlertType;
  severity: FitterFollowupSeverity;
  status: FitterFollowupAlertStatus;
  fitterInviteId: string | null;
  fitRequestId: string | null;
  fitSessionId: string | null;
  patientId: string | null;
  /** Counts and ids only — never a name, contact or clinical finding. */
  detail: Record<string, unknown>;
  nudgeCount: number;
  lastNudgeAt: string | null;
  lastNudgeChannel: string | null;
  resolvedAt: string | null;
  resolvedReason: FitterFollowupResolvedReason | null;
  dismissedAt: string | null;
  dismissedByEmail: string | null;
  staffNote: string | null;
  createdAt: string;
  contact: FitterFollowupContact | null;
  inviteStatus: string | null;
  inviteChannel: string | null;
  inviteExpiresAt: string | null;
  recommendedMaskName: string | null;
  fittingCompletedAt: string | null;
  linkSentAt: string | null;
  requestStatus: string | null;
  requestType: string | null;
  requestCreatedAt: string | null;
}

export interface ListFitterFollowupAlertsResponse {
  alerts: FitterFollowupAlertRow[];
  /** OPEN counts per type — always open, whatever filter is applied. */
  counts: Record<FitterFollowupAlertType, number>;
  openTotal: number;
  openHigh: number;
}

async function readError(res: Response, method: string, url: string) {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // body not JSON
  }
  return new ApiError(res, data, { method, url });
}

export async function listFitterFollowupAlerts(
  status: FitterFollowupAlertStatus | "all" = "open",
  type: FitterFollowupAlertType | "all" = "all",
): Promise<ListFitterFollowupAlertsResponse> {
  const params = new URLSearchParams();
  params.set("status", status);
  if (type !== "all") params.set("type", type);
  const url = `/resupply-api/admin/fitter-followup-alerts?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw await readError(res, "GET", url);
  return (await res.json()) as ListFitterFollowupAlertsResponse;
}

export interface UpdateFitterFollowupAlertInput {
  /** `resolved` is deliberately not settable — only the sweep asserts
   *  that the patient actually acted. */
  status?: "open" | "dismissed";
  /** Omit to leave the note alone; null or "" clears it. */
  staffNote?: string | null;
}

export async function updateFitterFollowupAlert(
  id: string,
  body: UpdateFitterFollowupAlertInput,
): Promise<{ alert: FitterFollowupAlertRow }> {
  const url = `/resupply-api/admin/fitter-followup-alerts/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, "PATCH", url);
  return (await res.json()) as { alert: FitterFollowupAlertRow };
}
