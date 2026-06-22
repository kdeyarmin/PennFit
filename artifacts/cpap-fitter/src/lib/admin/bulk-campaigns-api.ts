// Hand-rolled fetch wrapper for /admin/bulk-campaigns/*.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

// Tick interval from the backend worker — used in the UI to show
// pause/cancel latency ("takes effect within N seconds").
export const TICK_INTERVAL_SECONDS = 10;

export type AudienceKind =
  | "all_active_shop_customers"
  | "all_active_patients"
  | "by_patient_payer"
  | "by_therapy_cohort"
  | "patient_segment"
  | "manual_list";

/** RT clinical cohorts (C-R1) — patients with an open compliance alert. */
export type TherapyCohort = "low_adherence" | "no_checkin_response" | "at_risk";

export type Category = "marketing" | "service" | "compliance";

export type Channel = "email" | "sms";

/** equipment_assets.device_class values usable in a patient segment.
 *  Mirrors SEGMENT_DEVICE_CLASSES on the server. */
export const SEGMENT_DEVICE_CLASSES = [
  "cpap",
  "auto_cpap",
  "bipap",
  "asv",
  "avaps",
  "humidifier",
  "oximeter",
  "other",
] as const;

export type SegmentDeviceClass = (typeof SEGMENT_DEVICE_CLASSES)[number];

/** Composable patient-segment filter (audienceKind='patient_segment').
 *  Criteria are ANDed; every field is optional but at least one is
 *  required by the server. Mirrors PatientSegmentFilter on the API. */
export interface PatientSegmentFilter {
  manufacturers?: string[];
  deviceClasses?: SegmentDeviceClass[];
  equipmentModelContains?: string;
  therapyFailing?: boolean;
  insurancePayer?: string;
  notContactedInDays?: number;
}

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
  /** Human summary of the segment filter, when audienceKind='patient_segment'. */
  audienceFilterSummary?: string | null;
  channel: Channel;
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
  recipientPhone?: string | null;
  status: RecipientStatus;
  suppressionReason: string | null;
}

export interface BulkCampaignDetail extends BulkCampaignListItem {
  complianceAttestation: string | null;
  audienceFilter?: PatientSegmentFilter | null;
  recipients: RecipientPreview[];
}

export interface CreateDraftRequest {
  name: string;
  description?: string | null;
  audienceKind: AudienceKind;
  audiencePayer?: string | null;
  /** Required when audienceKind='by_therapy_cohort'. */
  therapyCohort?: TherapyCohort;
  /** Required when audienceKind='patient_segment'. */
  patientSegment?: PatientSegmentFilter;
  manualShopCustomerIds?: string[];
  manualPatientIds?: string[];
  /** Delivery channel. Defaults to email server-side. */
  channel?: Channel;
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
