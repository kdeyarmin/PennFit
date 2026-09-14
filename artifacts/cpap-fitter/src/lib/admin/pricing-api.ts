import { adminJsonFetch } from "../admin-json-fetch";
import type {
  PricingEvaluation,
  CsrOrderItem,
} from "@workspace/api-client-react/admin";
import type {
  PricingProposalInput,
  PricingProposal,
  PricingRecommendation,
  PricingDiscountHeadroom,
} from "@workspace/api-client-react/admin";
export type { PricingProposalInput, PricingProposal, PricingDiscountHeadroom };
import type {
  OfferInput,
  OfferVersion,
  PolicyInput,
  PolicyVersion,
  Scenario,
  ResolvedScenario,
  Quote,
  PricingState,
  PriceBatch,
  ActualEvent,
  Reconciliation,
} from "@workspace/api-client-react/admin";

export type {
  OfferInput,
  OfferVersion,
  PolicyInput,
  PolicyVersion,
  Scenario,
  ResolvedScenario,
  Quote,
  PricingState,
  PriceBatch,
  ActualEvent,
  Reconciliation,
};
export const pricingKey = ["admin", "pricing"] as const;
const get = <T>(path: string) => adminJsonFetch<T>(`/admin/pricing${path}`);
const post = <T>(path: string, body: unknown) =>
  adminJsonFetch<T>(`/admin/pricing${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
export const getPricingState = () => get<PricingState>("/state");
export const getPricingOffers = (offset = 0, sku?: string, view?: "latest") =>
  get<{ offers: OfferVersion[]; hasMore?: boolean }>(
    `/offers?limit=100&offset=${offset}${sku ? `&sku=${encodeURIComponent(sku)}` : ""}${view ? `&view=${view}` : ""}`,
  );
export const savePricingOffer = (body: OfferInput) =>
  post<OfferVersion>("/offers", body);
export const getPricingPolicies = () =>
  get<{ policies: PolicyVersion[] }>("/policies?limit=100");
export const savePricingPolicy = (body: PolicyInput) =>
  post<PolicyVersion>("/policies", body);
export const publishPricingPolicy = (
  id: string,
  body: {
    expectedStateRevision: number;
    enabled: boolean;
    enforceQuotes: boolean;
  },
) => post<PricingState>(`/policies/${encodeURIComponent(id)}/publish`, body);
export const evaluatePricingScenario = (body: Scenario) =>
  post<ResolvedScenario>("/evaluate", body);
export const getPricingDiscountHeadroom = (
  scenario: Scenario,
  maxAdditionalDiscountCents: number,
) =>
  post<ResolvedScenario & { discountHeadroom: PricingDiscountHeadroom }>(
    "/discount-headroom",
    { scenario, maxAdditionalDiscountCents },
  );
export const recommendPricingScenario = (scenario: Scenario, lineId?: string) =>
  post<ResolvedScenario & { recommendation: PricingRecommendation }>(
    "/recommend",
    { scenario, lineId },
  );
export const getPricingQuotes = (
  offset = 0,
  filters: { patientId?: string; status?: string } = {},
) =>
  get<{ quotes: Quote[]; hasMore: boolean }>(
    `/quotes?limit=50&offset=${offset}${filters.patientId ? `&patientId=${encodeURIComponent(filters.patientId)}` : ""}${filters.status ? `&status=${encodeURIComponent(filters.status)}` : ""}`,
  );
export const getPricingQuote = (id: string) =>
  get<Quote>(`/quotes/${encodeURIComponent(id)}`);
export const savePricingQuote = (body: {
  id?: string;
  expectedRevision?: number;
  scenario: Scenario;
  requestApproval: boolean;
}) => post<Quote>("/quotes", body);
export const approvePricingQuote = (
  id: string,
  body: { expectedRevision: number; reason: string; allowException: boolean },
) => post<Quote>(`/quotes/${encodeURIComponent(id)}/approve`, body);
export const getPricingBatches = () =>
  get<{ batches: PriceBatch[] }>("/batches?limit=100");
export const previewPricingBatch = (body: {
  name: string;
  scenarios: Scenario[];
}) => post<PriceBatch>("/batches/preview", body);
export const activatePricingBatch = (
  id: string,
  expectedStateRevision: number,
) =>
  post<PricingState>(`/batches/${encodeURIComponent(id)}/activate`, {
    expectedStateRevision,
  });
export const getPricingActuals = (id: string) =>
  get<Reconciliation>(`/quotes/${encodeURIComponent(id)}/actuals`);
export const savePricingActual = (
  id: string,
  body: Omit<ActualEvent, "id" | "createdAt">,
) => post<Reconciliation>(`/quotes/${encodeURIComponent(id)}/actuals`, body);
export const closePricingActuals = (
  id: string,
  body: {
    expectedRevision: number;
    costsComplete: boolean;
    revenueComplete: boolean;
    reason: string;
  },
) =>
  post<Reconciliation>(`/quotes/${encodeURIComponent(id)}/actuals/close`, body);
export type PricingShippingRate = {
  carrierCode: string;
  serviceCode: string;
  serviceDescription: string;
  totalCents: number;
  zone: string | null;
  shippingQuoteId: string;
  expiresAt: string;
};
export const getPricingShippingRates = (body: {
  patientId: string;
  lines: { sku: string; quantity: number }[];
  parcels: {
    weightOz: number;
    lengthIn: number;
    widthIn: number;
    heightIn: number;
  }[];
  residential: boolean;
}) =>
  post<{ rates: PricingShippingRate[]; origin: "configured_warehouse" }>(
    "/shipping-rates",
    body,
  );
export const getPricingProposals = (offset = 0) =>
  get<{ proposals: PricingProposal[]; hasMore: boolean }>(
    `/proposals?limit=50&offset=${offset}`,
  );
export const savePricingProposal = (body: PricingProposalInput) =>
  post<PricingProposal>("/proposals", body);
export const reviewPricingProposal = (
  id: string,
  body: {
    expectedRevision: number;
    status: "reviewing" | "resolved" | "rejected";
    sku?: string;
    notes: string;
  },
) => post<PricingProposal>(`/proposals/${encodeURIComponent(id)}/review`, body);

export type {
  RevenueProfileInput,
  RevenueProfile,
  PricingAlert,
} from "@workspace/api-client-react/admin";
import type {
  RevenueProfileInput,
  RevenueProfile,
  PricingAlert,
} from "@workspace/api-client-react/admin";
export const getPricingRevenueProfiles = (
  offset = 0,
  patientId?: string,
  view?: "history",
) =>
  get<{ profiles: RevenueProfile[]; hasMore: boolean }>(
    `/revenue-profiles?limit=50&offset=${offset}${patientId ? `&patientId=${encodeURIComponent(patientId)}` : ""}${view ? `&view=${view}` : ""}`,
  );
export const savePricingRevenueProfile = (body: RevenueProfileInput) =>
  post<RevenueProfile>("/revenue-profiles", body);
export const getActivePricingPrices = () =>
  get<{ batch: PriceBatch | null }>("/active-prices");
export const getPricingAlerts = () =>
  get<{ alerts: PricingAlert[] }>("/alerts");
export const reviewPricingAlert = (
  key: string,
  body: {
    expectedRevision: number;
    status: "open" | "resolved";
    owner: string;
    reviewAt: string | null;
    notes: string;
  },
) => post<PricingAlert>(`/alerts/${encodeURIComponent(key)}/review`, body);
export const schedulePricingBatch = (
  id: string,
  expectedStateRevision: number,
  scheduledAt: string,
) =>
  post<PriceBatch>(`/batches/${encodeURIComponent(id)}/schedule`, {
    expectedStateRevision,
    scheduledAt,
  });
export const cancelPricingBatchSchedule = (
  id: string,
  expectedStateRevision: number,
) =>
  post<PriceBatch>(`/batches/${encodeURIComponent(id)}/cancel-schedule`, {
    expectedStateRevision,
  });

import type { PricingSummary } from "@workspace/api-client-react/admin";
export const getPricingSummary = () => get<PricingSummary>("/summary");
export type DeliveryPricingPreview = {
  reviewId: string;
  revision: number;
  expiresAt: string;
  approvalClass: "firm" | "exception" | "blocked";
  evaluation: PricingEvaluation;
  originalEvaluation: PricingEvaluation;
  items: CsrOrderItem[];
  patientId: string;
  addressSnapshot: Record<string, unknown>;
};
export type DeliveryPricingInput = {
  delivery: { country: string; service: string };
  shippingQuoteId?: string;
  freight?: { amountCents: number; source: string; expiresAt: string };
  revenueVerification?: { source: string; expiresAt: string };
  costVerification?: { source: string; expiresAt: string };
};
export const previewDeliveryPricing = (
  id: string,
  body: DeliveryPricingInput,
) =>
  adminJsonFetch<DeliveryPricingPreview>(
    `/admin/csr-order-requests/${encodeURIComponent(id)}/delivery-review/preview`,
    { method: "POST", body: JSON.stringify(body) },
  );
export const approveDeliveryPricing = (
  id: string,
  reviewId: string,
  body: { revision: number; reason: string; allowException: boolean },
) =>
  adminJsonFetch<{
    fulfillmentIds: string[];
    skipped: string | null;
    replayed: boolean;
  }>(
    `/admin/csr-order-requests/${encodeURIComponent(id)}/delivery-review/${encodeURIComponent(reviewId)}/approve`,
    { method: "POST", body: JSON.stringify(body) },
  );
