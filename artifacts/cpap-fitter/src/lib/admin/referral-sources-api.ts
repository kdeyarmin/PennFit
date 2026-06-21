// Hand-rolled fetch wrappers for the admin referral-source CRM endpoints
// (GET /admin/referrals/scorecard, GET/POST
// /admin/providers/:id/referral-activity). Same rationale as the other v1
// admin api wrappers (abandoned-carts-api.ts): not in the OpenAPI spec.
//
// Auth: the browser sends the `pf_session` cookie automatically on
// same-origin requests, so no per-call auth header is needed.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export interface ReferralSourceRow {
  providerId: string;
  providerName: string | null;
  practiceName: string | null;
  npi: string | null;
  claimCount: number;
  patientCount: number;
  claimsSince: number;
  paidCents: number;
  lastActivityOn: string | null;
}

export interface ReferralScorecardResponse {
  sinceDays: number;
  sources: ReferralSourceRow[];
}

export interface ReferralActivityRow {
  id: string;
  providerId: string;
  activityType: string;
  occurredOn: string;
  summary: string;
  nextAction: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface ReferralActivityResponse {
  providerId: string;
  activity: ReferralActivityRow[];
}

export interface LogReferralActivityInput {
  activityType?: string;
  occurredOn?: string;
  summary: string;
  nextAction?: string | null;
}

async function readJsonOrThrow<T>(
  res: Response,
  method: string,
  url: string,
): Promise<T> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body — leave data null
  }
  if (!res.ok) {
    throw new ApiError(res, data, { method, url });
  }
  return data as T;
}

export async function getReferralScorecard(
  sinceDays = 90,
): Promise<ReferralScorecardResponse> {
  const url = `/resupply-api/admin/referrals/scorecard?sinceDays=${encodeURIComponent(
    String(sinceDays),
  )}`;
  const res = await fetch(url, { credentials: "same-origin" });
  return readJsonOrThrow<ReferralScorecardResponse>(res, "GET", url);
}

export async function getReferralActivity(
  providerId: string,
): Promise<ReferralActivityResponse> {
  const url = `/resupply-api/admin/providers/${encodeURIComponent(
    providerId,
  )}/referral-activity`;
  const res = await fetch(url, { credentials: "same-origin" });
  return readJsonOrThrow<ReferralActivityResponse>(res, "GET", url);
}

export async function logReferralActivity(
  providerId: string,
  input: LogReferralActivityInput,
): Promise<{ id: string; occurredOn: string }> {
  const url = `/resupply-api/admin/providers/${encodeURIComponent(
    providerId,
  )}/referral-activity`;
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<{ id: string; occurredOn: string }>(res, "POST", url);
}
