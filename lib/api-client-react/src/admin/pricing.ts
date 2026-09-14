import type {
  PricingEvaluation,
  PricingInput,
  PricingRecommendation,
} from "@workspace/resupply-domain";
export type { PricingEvaluation, PricingRecommendation };
export type PricingDiscountHeadroom = {
  status:
    | "calculated"
    | "search_limit"
    | "cost_information_needed"
    | "self_pay_required"
    | "fixed_capture_amounts"
    | "blocked_policy";
  searchUpperBoundCents: number;
  remainingMerchandiseCents: number;
  wholeDomainSearched: boolean;
  target: {
    additionalDiscountCents: number;
    evaluation: PricingEvaluation;
  } | null;
  floor: {
    additionalDiscountCents: number;
    evaluation: PricingEvaluation;
  } | null;
};
export type CostStatus = "verified" | "estimated" | "missing" | "stale";
export type PricingCost = {
  id: string;
  label: string;
  category:
    | "goods"
    | "inbound"
    | "dropship"
    | "freight"
    | "handling"
    | "packaging"
    | "other";
  basis: "order" | "shipment" | "parcel" | "unit";
  amountCents: number | null;
  quantity: number;
  status: CostStatus;
  expiresAt?: string;
  includedInId?: string;
};
export type OfferInput = {
  availability?:
    | "available"
    | "limited"
    | "backorder"
    | "unavailable"
    | "unknown";
  leadTimeDays?: number | null;
  returnTerms?: string;
  clinicalSuitability?: string;
  deliveryScope?: {
    country: string;
    postalPrefixes: string[];
    service: string;
    fulfillmentMethods: Array<"stock" | "dropship">;
  } | null;
  id?: string;
  expectedVersion?: number;
  supplierName: string;
  supplierSku: string;
  sku: string;
  currency: "USD";
  unitCostCents: number | null;
  unitsPerPack: number;
  minQuantity: number;
  maxQuantity: number | null;
  status: CostStatus;
  effectiveFrom: string;
  expiresAt: string;
  source: string;
  components: PricingCost[];
};
export type OfferVersion = Omit<OfferInput, "expectedVersion"> & {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
};
export type PolicyInput = {
  name: string;
  effectiveFrom: string;
  expiresAt: string;
  rules: PricingInput["policy"];
  overrides?: Array<{
    scope: "sku" | "category" | "revenue_mode";
    value: string;
    priority: number;
    effectiveFrom: string;
    expiresAt: string;
    rules: PricingInput["policy"];
  }>;
};
export type PolicyVersion = PolicyInput & {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
};
export type PricingQuoteLine = {
  id: string;
  sku: string;
  description: string;
  quantity: number;
  unitAmountCents: number;
  fulfillmentMethod: "stock" | "dropship";
  taxBps?: number;
  offerId: string;
  offerVersion: number;
};
export type Scenario = {
  delivery?: { country: string; postalCode: string; service: string };
  patientId?: string;
  policyId?: string;
  shippingQuoteId?: string;
  revenueProfileId?: string;
  revenueProfileVersion?: number;
  validUntil: string;
  lines: PricingQuoteLine[];
  revenue:
    | {
        mode: "insurance";
        expectedCollectibleCents: number | null;
        status: CostStatus;
        source?: string;
        allowedCents?: number;
        expiresAt?: string;
      }
    | {
        mode: "self_pay";
        shippingChargedCents: number;
        shippingTaxBps?: number;
        discountBps?: number;
        discountCents?: number;
      };
  costs?: PricingCost[];
  processing?: {
    rateBps: number;
    fixedCents: number;
    chargeCount?: number;
    basis: "customer_total" | "net_sales" | "explicit";
    explicitBaseCents?: number;
  };
  adjustments?: {
    expectedRefundCents?: number;
    returnCostCents?: number;
    recoveryCents?: number;
    riskCostCents?: number;
    overheadCents?: number;
  };
};
export type ResolvedScenario = {
  scenario: Scenario;
  input: PricingInput;
  evaluation: PricingEvaluation;
  dependencies: { offerId: string; version: number; expiresAt: string }[];
  policyId: string;
  policyVersion: number;
  recommendation?: PricingRecommendation;
};
export type Quote = ResolvedScenario & {
  id: string;
  revision: number;
  status: "draft" | "pending_approval" | "approved" | "bound";
  patientId: string | null;
  lines: Array<PricingQuoteLine & { unitCostCents: number | null }>;
  validUntil: string;
  approvedBy: string | null;
  approvedAt: string | null;
  boundOrderId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PricingState = {
  revision: number;
  enabled: boolean;
  enforceQuotes: boolean;
  policy: PolicyVersion | null;
  activePriceListId: string | null;
};
export type PriceBatch = {
  id: string;
  name: string;
  createdAt: string;
  entries: Array<
    ResolvedScenario & {
      comparison?: PricingPriceComparison;
      changeKind?: "selected" | "retained";
    }
  >;
  selectedEntryCount?: number;
  retainedEntryCount?: number;
  active: boolean;
  scheduledAt: string | null;
  scheduleStatus: "pending" | "applied" | "cancelled" | "blocked" | null;
  scheduleError: string | null;
};
export type PricingPriceComparison = {
  status:
    | "comparable"
    | "no_published_price"
    | "ambiguous_published_price"
    | "comparison_unavailable";
  reason: string | null;
  evaluatedAt: string;
  previousPriceListId: string | null;
  previousEntryIndexes: number[];
  previousUnitAmounts: Array<{
    sku: string;
    quantity: number;
    unitAmountCents: number;
  }>;
  previousInput: PricingInput | null;
  previousEvaluation: PricingEvaluation | null;
};
export type PricingPortfolioEntry = {
  batchId: string;
  entryIndex: number;
  entry: ResolvedScenario;
  suppliers?: Array<{ sku: string; offerId: string; supplierName: string }>;
};
export type PricingPortfolioItem = {
  sku: string;
  name: string;
  category: string | null;
  offers: OfferVersion[];
  hasMoreOffers: boolean;
  activeEntries: PricingPortfolioEntry[];
};
export type PricingPortfolio = {
  items: PricingPortfolioItem[];
  hasMore: boolean;
};
export type ActualEventInput = {
  source:
    | "supplier_invoice"
    | "freight_invoice"
    | "payment_fee"
    | "collection"
    | "refund"
    | "supplier_credit"
    | "adjustment";
  sourceRef: string;
  economicEventId: string;
  kind: "cost" | "revenue" | "refund" | "cost_credit";
  amountCents: number;
  lineId?: string;
  occurredAt: string;
  notes?: string;
};
export type ActualEvent = ActualEventInput & { id: string; createdAt: string };
export type Reconciliation = {
  forecast: {
    status: "available" | "blocked";
    evaluation: PricingEvaluation | null;
    reason: string | null;
    evaluatedAt: string;
  };
  quote: Quote;
  events: ActualEvent[];
  eventPage: { offset: number; limit: number; total: number; hasMore: boolean };
  revision: number;
  costsComplete: boolean;
  revenueComplete: boolean;
  settled: boolean;
  actualRevenueCents: number;
  actualCostCents: number;
  actualContributionCents: number;
  actualMarginBps: number | null;
  quotedRevenueCents: number | null;
  quotedCostCents: number | null;
  costVarianceCents: number | null;
  revenueVarianceCents: number | null;
};
export type PricingProposalInput = {
  comparison?: import("@workspace/resupply-domain").ProvisionalSupplierComparison;
  estimatedUnitCostCents?: number | null;
  estimatedDropshipFeeCents?: number | null;
  terms?: string;
  expiresAt?: string | null;
  name: string;
  manufacturer: string;
  model: string;
  size: string;
  packDescription: string;
  source: string;
  notes: string;
};
export type PricingProposal = PricingProposalInput & {
  comparisonResult?: import("@workspace/resupply-domain").ProvisionalComparisonResult;
  id: string;
  revision: number;
  status: "open" | "reviewing" | "resolved" | "rejected";
  sku: string | null;
  reviewNotes: string | null;
  createdAt: string;
};

export type RevenueProfileInput = {
  expectedInsurerCents?: number;
  expectedSecondaryCents?: number;
  expectedPatientCents?: number;
  collectionAdjustmentCents?: number;
  id?: string;
  expectedVersion?: number;
  name: string;
  patientId: string;
  lines: Array<{ sku: string; quantity: number }>;
  allowedCents: number;
  expectedCollectibleCents: number;
  source: string;
  effectiveFrom: string;
  expiresAt: string;
};
export type RevenueProfile = Omit<RevenueProfileInput, "expectedVersion"> & {
  id: string;
  version: number;
  createdAt: string;
};
export type PricingAlert = {
  key: string;
  code: string;
  entityId: string;
  amountCents: number | null;
  createdAt: string;
  revision: number;
  status: "open" | "resolved";
  owner: string;
  reviewAt: string | null;
  notes: string;
};

export type PricingSummary = {
  groups: Array<{
    status: "settled" | "incomplete";
    quoteCount: number;
    revenueCents: number;
    costCents: number;
    contributionCents: number;
    marginBps: number | null;
    quotedRevenueCents: number;
    quotedCostCents: number;
    incompleteQuotedCount: number;
  }>;
};
