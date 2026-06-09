// Hand-rolled fetch wrapper for /admin/bulk-campaigns/*.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

// Tick interval from the backend worker — used in the UI to show
// pause/cancel latency ("takes effect within N seconds").
export const TICK_INTERVAL_SECONDS = 10;

export type AudienceKind =
  | "all_active_shop_customers"
  | "all_active_patients"
  | "by_patient_payer"
  | "by_therapy_cohort"
  | "manual_list";

/** RT clinical cohorts (C-R1) — patients with an open compliance alert. */
export type TherapyCohort = "low_adherence" | "no_checkin_response" | "at_risk";

export type Category = "marketing" | "service" | "compliance";

export type CampaignStatus =
  | "draft"
  | "sending"
  | "sent"
  | "paused"
  | "cancelled";

export type RecipientStatus =
  | "pending"
  | "suppressed"
  | "sending"
  | "sent"
  | "failed";

export interface BulkCampaignListItem {
  id: string;
  name: string;
  description: string | null;
  audienceKind: AudienceKind;
  audiencePayer: string | null;
  channel: "email";
  category: Category;
  templateKey: string;
  throttlePerMinute: number;
  status: CampaignStatus;
  totalRecipients: number;
  pendingRecipients: number;
  suppressedCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface RecipientPreview {
  id: string;
  recipientKind: "patient" | "shop_customer";
  recipientId: string;
  recipientEmail: string | null;
  status: RecipientStatus;
  suppressionReason: string | null;
}

export interface BulkCampaignDetail extends BulkCampaignListItem {
  complianceAttestation: string | null;
  recipients: RecipientPreview[];
}

export interface CreateDraftRequest {
  name: string;
  description?: string | null;
  audienceKind: AudienceKind;
  audiencePayer?: string | null;
  /** Required when audienceKind='by_therapy_cohort'. */
  therapyCohort?: TherapyCohort;
  manualShopCustomerIds?: string[];
  manualPatientIds?: string[];
  category: Category;
  complianceAttestation?: string | null;
  templateKey: string;
  throttlePerMinute?: number;
}

export interface CreateDraftResponse {
  id: string;
  totals: {
    total: number;
    pending: number;
    suppressed: number;
  };
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...restInit } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    ...restInit,
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
      // ignore
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const listBulkCampaigns = () =>
  jsonFetch<{ campaigns: BulkCampaignListItem[] }>(`/admin/bulk-campaigns`);

export const getBulkCampaign = (id: string) =>
  jsonFetch<BulkCampaignDetail>(
    `/admin/bulk-campaigns/${encodeURIComponent(id)}`,
  );

export const createBulkCampaignDraft = (body: CreateDraftRequest) =>
  jsonFetch<CreateDraftResponse>(`/admin/bulk-campaigns/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const cancelBulkCampaign = (id: string) =>
  jsonFetch<{ id: string; status: "cancelled" }>(
    `/admin/bulk-campaigns/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );

export const startBulkCampaign = (id: string) =>
  jsonFetch<{ id: string; status: "sending" }>(
    `/admin/bulk-campaigns/${encodeURIComponent(id)}/start`,
    { method: "POST" },
  );

export const pauseBulkCampaign = (id: string) =>
  jsonFetch<{ id: string; status: "paused" }>(
    `/admin/bulk-campaigns/${encodeURIComponent(id)}/pause`,
    { method: "POST" },
  );

export const resumeBulkCampaign = (id: string) =>
  jsonFetch<{ id: string; status: "sending" }>(
    `/admin/bulk-campaigns/${encodeURIComponent(id)}/resume`,
    { method: "POST" },
  );
