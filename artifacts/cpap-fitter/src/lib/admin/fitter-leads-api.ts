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
  /** Mig 0154 — click tracking + CSR contact workflow. */
  clickCount: number;
  csrContactedAt: string | null;
  csrContactedBy: string | null;
  /** Mig 0155 — per-lead engagement recency. */
  lastOpenAt: string | null;
  lastClickAt: string | null;
  /** Mig 0156 — CSR free-text notes + dispatcher cold-skip marker. */
  csrNotes: string | null;
  coldSkippedAt: string | null;
}

export interface ListFitterLeadsResponse {
  rows: FitterLeadRow[];
  counts: Record<FitterLeadJourneyStage, number>;
  conversionRate: number;
  /** Count of active (un-converted, un-unsubscribed) hot leads
   *  across all stages — the CSR outreach priority queue. */
  hotLeadsActive: number;
  /** Subset of hotLeadsActive that hasn't been contacted yet —
   *  the actionable "call now" number for ops. */
  hotLeadsNeedingContact: number;
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

export interface MarkContactedFitterLeadResponse {
  id: string;
  csrContactedAt: string;
  csrContactedBy: string | null;
}

export async function markContactedFitterLead(
  id: string,
): Promise<MarkContactedFitterLeadResponse> {
  const res = await fetch(
    `/resupply-api/admin/fitter-leads/${encodeURIComponent(id)}/mark-contacted`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to mark lead contacted (${res.status})`);
  }
  return (await res.json()) as MarkContactedFitterLeadResponse;
}

export interface FitterTouchMetric {
  touchIndex: number;
  emailSends: number;
  emailFailures: number;
  smsSends: number;
  smsFailures: number;
  opens: number;
  clicks: number;
  openRate: number;
  clickRate: number;
}

export interface ListFitterTouchMetricsResponse {
  touches: FitterTouchMetric[];
}

export async function listFitterTouchMetrics(): Promise<ListFitterTouchMetricsResponse> {
  const res = await fetch("/resupply-api/admin/fitter-leads/metrics", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load fitter metrics (${res.status})`);
  }
  return (await res.json()) as ListFitterTouchMetricsResponse;
}

export interface FitterTimelineEvent {
  ts: string;
  kind: string;
  label: string;
  detail?: string | null;
}

export interface FitterLeadTimelineResponse {
  leadId: string;
  events: FitterTimelineEvent[];
}

export async function getFitterLeadTimeline(
  id: string,
): Promise<FitterLeadTimelineResponse> {
  const res = await fetch(
    `/resupply-api/admin/fitter-leads/${encodeURIComponent(id)}/timeline`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Failed to load timeline (${res.status})`);
  }
  return (await res.json()) as FitterLeadTimelineResponse;
}

export interface SetFitterLeadNotesResponse {
  id: string;
  csrNotes: string | null;
}

export async function setFitterLeadNotes(
  id: string,
  notes: string | null,
): Promise<SetFitterLeadNotesResponse> {
  const res = await fetch(
    `/resupply-api/admin/fitter-leads/${encodeURIComponent(id)}/notes`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ notes }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to set lead notes (${res.status})`);
  }
  return (await res.json()) as SetFitterLeadNotesResponse;
}
