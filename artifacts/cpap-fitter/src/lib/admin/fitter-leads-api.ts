// Hand-rolled fetch wrappers for the admin fitter-leads endpoints.
//
// Same rationale as insurance-leads-api.ts: the v1 admin surface isn't
// in the OpenAPI spec yet; a thin hand wrapper avoids a codegen cycle
// for every backend tweak. The browser sends `pf_session` automatically
// on same-origin requests, so no auth header is needed per call.

export type FitterLeadJourneyStage =
  | "consent"
  | "completed"
  | "campaign_active"
  | "reorder_active"
  | "final_call_pending"
  | "converted"
  | "unsubscribed"
  | "expired";

export type FitterLeadSource =
  | "consent"
  | "sleep_apnea_quiz"
  | "insurance_quote";

export interface FitterLeadRow {
  id: string;
  email: string;
  phoneE164: string | null;
  smsOptIn: boolean;
  marketingOptIn: boolean;
  source: FitterLeadSource;
  journeyStage: FitterLeadJourneyStage;
  recommendedMaskId: string | null;
  recommendedMaskName: string | null;
  recommendedMaskType: string | null;
  /** Mig 0152 — first-name personalization captured on conversion. */
  firstName: string | null;
  campaignTouchCount: number;
  lastCampaignTouchAt: string | null;
  nextCampaignTouchAt: string | null;
  firstOrderId: string | null;
  firstOrderPlacedAt: string | null;
  unsubscribedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Mig 0153 — engagement signals from open tracking. */
  engagementScore: number;
  hotLeadAt: string | null;
}

export interface ListFitterLeadsResponse {
  rows: FitterLeadRow[];
  counts: Record<FitterLeadJourneyStage, number>;
  conversionRate: number;
  /** Count of active (un-converted, un-unsubscribed) hot leads
   *  across all stages — the CSR outreach priority queue. */
  hotLeadsActive: number;
}

export async function listFitterLeads(
  stage: FitterLeadJourneyStage | "all" = "all",
  source: FitterLeadSource | "all" = "all",
  hotOnly: boolean = false,
): Promise<ListFitterLeadsResponse> {
  const params = new URLSearchParams();
  if (stage !== "all") params.set("stage", stage);
  if (source !== "all") params.set("source", source);
  if (hotOnly) params.set("hotOnly", "1");
  const qs = params.toString();
  const res = await fetch(
    `/resupply-api/admin/fitter-leads${qs ? `?${qs}` : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to load fitter leads (${res.status})`);
  }
  return (await res.json()) as ListFitterLeadsResponse;
}

export interface UnsubscribeFitterLeadResponse {
  id: string;
  journeyStage: FitterLeadJourneyStage;
  unsubscribedAt: string;
}

export async function unsubscribeFitterLead(
  id: string,
): Promise<UnsubscribeFitterLeadResponse> {
  const res = await fetch(
    `/resupply-api/admin/fitter-leads/${encodeURIComponent(id)}/unsubscribe`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to unsubscribe lead (${res.status})`);
  }
  return (await res.json()) as UnsubscribeFitterLeadResponse;
}
