import { z } from "zod";
import type {
  PricingEvaluation,
  PricingInput,
  ProvisionalComparisonResult,
} from "@workspace/resupply-domain";

const cents = z.number().int().min(0).max(100_000_000);
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const status = z.enum(["verified", "estimated", "missing", "stale"]);
export const costComponentSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(160),
    category: z.enum([
      "goods",
      "inbound",
      "dropship",
      "freight",
      "handling",
      "packaging",
      "other",
    ]),
    basis: z.enum(["order", "shipment", "parcel", "unit"]),
    amountCents: cents.nullable(),
    quantity: z.number().int().min(1).max(10_000),
    status,
    expiresAt: timestamp.optional(),
    includedInId: z.string().min(1).max(100).optional(),
  })
  .strict();
export const offerSchema = z
  .object({
    id: uuid.optional(),
    expectedVersion: z.number().int().positive().optional(),
    supplierName: z.string().trim().min(1).max(200),
    supplierSku: z.string().trim().min(1).max(100),
    sku: skuSchema,
    currency: z.literal("USD"),
    unitCostCents: cents.nullable(),
    unitsPerPack: z.number().int().positive().max(10_000),
    minQuantity: z.number().int().positive().max(10_000),
    maxQuantity: z.number().int().positive().max(10_000).nullable(),
    status,
    effectiveFrom: timestamp,
    expiresAt: timestamp,
    source: z.string().trim().min(1).max(1000),
    components: z.array(costComponentSchema).max(40),
    availability: z
      .enum(["available", "limited", "backorder", "unavailable", "unknown"])
      .optional(),
    leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
    returnTerms: z.string().trim().max(2000).optional(),
    clinicalSuitability: z.string().trim().max(2000).optional(),
    deliveryScope: z
      .object({
        country: z.string().length(2),
        postalPrefixes: z
          .array(z.string().trim().min(1).max(20))
          .min(1)
          .max(100),
        service: z.string().trim().min(1).max(100),
        fulfillmentMethods: z
          .array(z.enum(["stock", "dropship"]))
          .min(1)
          .max(2),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.maxQuantity !== null && value.maxQuantity < value.minQuantity)
      ctx.addIssue({
        code: "custom",
        message: "Maximum quantity must include minimum quantity.",
      });
    if (Date.parse(value.expiresAt) <= Date.parse(value.effectiveFrom))
      ctx.addIssue({
        code: "custom",
        message: "Expiry must follow the effective date.",
      });
    if (Boolean(value.id) !== Boolean(value.expectedVersion))
      ctx.addIssue({
        code: "custom",
        message: "An existing offer requires its current version.",
      });
    if (value.status === "verified" && value.unitCostCents === null)
      ctx.addIssue({
        code: "custom",
        message: "Verified offers require an explicit cost.",
      });
  });
export const policyRulesSchema = z
  .object({
    targetMarginBps: z.number().int().min(0).max(9999),
    floorMarginBps: z.number().int().min(0).max(9999),
    lineFloorMarginBps: z.number().int().min(0).max(9999).optional(),
    minimumContributionCents: cents.optional(),
    basis: z.enum(["contribution", "after_overhead"]),
    priceIncrementCents: cents.min(1).max(1_000_000).optional(),
    priceEndingCents: cents.optional(),
    priceCeilingCents: cents.optional(),
  })
  .strict()
  .refine(
    (value) => value.floorMarginBps <= value.targetMarginBps,
    "The floor cannot exceed the target.",
  )
  .refine(
    (value) =>
      value.priceEndingCents === undefined ||
      value.priceEndingCents < (value.priceIncrementCents ?? 1),
    "The price ending must be smaller than the increment.",
  );
export const policySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    effectiveFrom: timestamp,
    expiresAt: timestamp,
    rules: policyRulesSchema,
    overrides: z
      .array(
        z
          .object({
            scope: z.enum(["sku", "category", "revenue_mode"]),
            value: z.string().trim().min(1).max(100),
            priority: z.number().int().min(0).max(1000),
            effectiveFrom: timestamp,
            expiresAt: timestamp,
            rules: policyRulesSchema,
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.effectiveFrom))
      ctx.addIssue({
        code: "custom",
        message: "Expiry must follow the effective date.",
      });
    const keys = new Set<string>();
    for (const rule of value.overrides ?? []) {
      const key = `${rule.scope}:${rule.value}:${rule.priority}`;
      if (keys.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Override scope, value and priority must be unique.",
        });
      keys.add(key);
      if (
        Date.parse(rule.effectiveFrom) < Date.parse(value.effectiveFrom) ||
        Date.parse(rule.expiresAt) > Date.parse(value.expiresAt) ||
        Date.parse(rule.expiresAt) <= Date.parse(rule.effectiveFrom)
      )
        ctx.addIssue({
          code: "custom",
          message: "Override validity must lie inside the parent policy.",
        });
      if (
        rule.scope === "revenue_mode" &&
        !["insurance", "self_pay"].includes(rule.value)
      )
        ctx.addIssue({
          code: "custom",
          message: "Revenue override requires insurance or self_pay.",
        });
    }
  });
export const quoteLineSchema = z
  .object({
    id: uuid,
    sku: skuSchema,
    description: z.string().trim().min(1).max(300),
    quantity: z.number().int().min(1).max(10_000),
    unitAmountCents: cents,
    fulfillmentMethod: z.enum(["stock", "dropship"]),
    taxBps: z.number().int().min(0).max(10_000).optional(),
    offerId: uuid,
    offerVersion: z.number().int().positive(),
  })
  .strict();
const revenueSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("self_pay"),
      shippingChargedCents: cents,
      shippingTaxBps: z.number().int().min(0).max(10_000).optional(),
      discountBps: z.number().int().min(0).max(10_000).optional(),
      discountCents: cents.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("insurance"),
      expectedCollectibleCents: cents.nullable(),
      status,
      source: z.string().trim().min(1).max(1000).optional(),
      allowedCents: cents.optional(),
      expiresAt: timestamp.optional(),
    })
    .strict(),
]);
export const scenarioSchema = z
  .object({
    patientId: uuid.optional(),
    policyId: uuid.optional(),
    shippingQuoteId: uuid.optional(),
    revenueProfileId: uuid.optional(),
    revenueProfileVersion: z.number().int().positive().optional(),
    validUntil: timestamp,
    activePriceListId: uuid.nullable().optional(),
    // Returned for quote provenance. Submitted values are discarded and reloaded.
    deliveryAddressSnapshot: z.unknown().optional(),
    delivery: z
      .object({
        country: z.string().length(2),
        postalCode: z.string().trim().max(20).optional(),
        service: z.string().trim().min(1).max(100),
      })
      .strict()
      .optional(),
    lines: z.array(quoteLineSchema).min(1).max(100),
    revenue: revenueSchema,
    costs: z.array(costComponentSchema).max(100).optional(),
    processing: z
      .object({
        rateBps: z.number().int().min(0).max(10_000),
        fixedCents: cents,
        chargeCount: z.number().int().min(1).max(100).optional(),
        chargeAmountsCents: z.array(cents).min(1).max(100).optional(),
        basis: z.enum(["customer_total", "net_sales", "explicit"]),
        explicitBaseCents: cents.optional(),
        status: status.optional(),
        expiresAt: timestamp.optional(),
      })
      .strict()
      .optional(),
    adjustments: z
      .object({
        expectedRefundCents: cents.optional(),
        returnCostCents: cents.optional(),
        recoveryCents: cents.optional(),
        riskCostCents: cents.optional(),
        overheadCents: cents.optional(),
        processingFeeCreditCents: cents.optional(),
        status: status.optional(),
        expiresAt: timestamp.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.lines.map((line) => line.id)).size !== value.lines.length)
      ctx.addIssue({ code: "custom", message: "Line IDs must be unique." });
    if (
      Boolean(value.revenueProfileId) !== Boolean(value.revenueProfileVersion)
    )
      ctx.addIssue({
        code: "custom",
        message: "A verified revenue profile requires its exact version.",
      });
    if (value.delivery && !value.patientId && !value.delivery.postalCode)
      ctx.addIssue({
        code: "custom",
        message: "Catalog delivery scenarios require a postal code.",
      });
    if (
      new Set(value.lines.map((line) => line.sku)).size !== value.lines.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Use one canonical line per SKU.",
      });
    if (
      value.revenue.mode === "insurance" &&
      value.revenue.expectedCollectibleCents !== null &&
      value.revenue.allowedCents !== undefined &&
      value.revenue.expectedCollectibleCents > value.revenue.allowedCents
    )
      ctx.addIssue({
        code: "custom",
        message: "Expected collections cannot exceed the allowed amount.",
      });
  });
export const saveQuoteSchema = z
  .object({
    id: uuid.optional(),
    expectedRevision: z.number().int().positive().optional(),
    scenario: scenarioSchema,
    requestApproval: z.boolean(),
  })
  .strict();
export const approveQuoteSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(10).max(1000),
    allowException: z.boolean(),
  })
  .strict();
export const publishSchema = z
  .object({
    expectedStateRevision: z.number().int().min(0),
    enabled: z.boolean(),
    enforceQuotes: z.boolean(),
  })
  .strict()
  .refine(
    (value) => !value.enforceQuotes || value.enabled,
    "Quote enforcement requires pricing enabled.",
  );
export const batchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    scenarios: z.array(scenarioSchema).min(1).max(100),
  })
  .strict();
export const activateBatchSchema = z
  .object({ expectedStateRevision: z.number().int().min(0) })
  .strict();
export const scheduleBatchSchema = activateBatchSchema
  .extend({ scheduledAt: timestamp })
  .strict();
export const revenueProfileSchema = z
  .object({
    id: uuid.optional(),
    expectedVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(200),
    patientId: uuid,
    lines: z
      .array(
        z
          .object({
            sku: skuSchema,
            quantity: z.number().int().positive().max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    allowedCents: cents,
    expectedCollectibleCents: cents,
    expectedInsurerCents: cents.optional(),
    expectedSecondaryCents: cents.optional(),
    expectedPatientCents: cents.optional(),
    collectionAdjustmentCents: z
      .number()
      .int()
      .min(-100_000_000)
      .max(100_000_000)
      .optional(),
    source: z.string().trim().min(1).max(1000),
    effectiveFrom: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.id) !== Boolean(value.expectedVersion))
      ctx.addIssue({
        code: "custom",
        message: "Updating a revenue profile requires its current version.",
      });
    if (value.expectedCollectibleCents > value.allowedCents)
      ctx.addIssue({
        code: "custom",
        message: "Expected collections cannot exceed allowed revenue.",
      });
    if (Date.parse(value.expiresAt) <= Date.parse(value.effectiveFrom))
      ctx.addIssue({
        code: "custom",
        message: "Expiry must follow the effective date.",
      });
    if (
      new Set(value.lines.map((line) => line.sku)).size !== value.lines.length
    )
      ctx.addIssue({ code: "custom", message: "Profile SKUs must be unique." });
    const shares = [
      value.expectedInsurerCents,
      value.expectedSecondaryCents,
      value.expectedPatientCents,
      value.collectionAdjustmentCents,
    ];
    if (
      shares.some((share) => share !== undefined) &&
      (shares.some((share) => share === undefined) ||
        shares.reduce<number>((total, share) => total + (share ?? 0), 0) !==
          value.expectedCollectibleCents)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "All four allocation fields must sum exactly to expected collections.",
      });
  });
export const alertReviewSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    status: z.enum(["open", "resolved"]),
    owner: z.string().trim().max(200),
    reviewAt: timestamp.nullable(),
    notes: z.string().trim().min(1).max(1000),
  })
  .strict();
export const actualSchema = z
  .object({
    source: z.enum([
      "supplier_invoice",
      "freight_invoice",
      "payment_fee",
      "collection",
      "refund",
      "supplier_credit",
      "adjustment",
    ]),
    sourceRef: z.string().trim().min(1).max(200),
    economicEventId: z.string().trim().min(1).max(200),
    kind: z.enum(["cost", "revenue", "refund", "cost_credit"]),
    amountCents: cents,
    lineId: uuid.optional(),
    occurredAt: timestamp,
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const requiredKind = {
      supplier_invoice: "cost",
      freight_invoice: "cost",
      payment_fee: "cost",
      collection: "revenue",
      refund: "refund",
      supplier_credit: "cost_credit",
    } as const;
    if (
      value.source !== "adjustment" &&
      requiredKind[value.source] !== value.kind
    )
      ctx.addIssue({
        code: "custom",
        message: "The event kind must match its source.",
      });
  });
export const closeActualsSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    costsComplete: z.boolean(),
    revenueComplete: z.boolean(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const provisionalComparisonSchema = z
  .object({
    currency: z.literal("USD"),
    quantity: z.number().int().min(1).max(10_000),
    destination: z.string().trim().max(200),
    service: z.string().trim().max(100),
    suppliers: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100),
            supplierName: z.string().trim().max(200),
            source: z.string().trim().max(1000),
            expiresAt: timestamp.nullable(),
            packCostCents: cents.nullable(),
            unitsPerPack: z.number().int().min(1).max(10_000),
            minimumPacks: z.number().int().min(1).max(10_000),
            availability: z.enum([
              "available",
              "limited",
              "backorder",
              "unavailable",
              "unknown",
            ]),
            leadTimeDays: z.number().int().min(0).max(365).nullable(),
            terms: z.string().trim().max(2000),
            fees: z
              .array(
                z
                  .object({
                    id: z.string().trim().min(1).max(100),
                    label: z.string().trim().min(1).max(160),
                    category: z.enum([
                      "inbound",
                      "dropship",
                      "freight",
                      "handling",
                      "packaging",
                      "other",
                    ]),
                    amountCents: cents.nullable(),
                    basis: z.enum(["order", "parcel", "pack"]),
                    count: z.number().int().min(1).max(10_000),
                    includedIn: z.literal("pack").optional(),
                  })
                  .strict()
                  .refine(
                    (fee) => fee.basis === "parcel" || fee.count === 1,
                    "Order and pack charges require a count of one.",
                  ),
              )
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
export const proposalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    manufacturer: z.string().trim().max(200),
    model: z.string().trim().max(200),
    size: z.string().trim().max(100),
    packDescription: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(1000),
    notes: z.string().trim().max(2000),
    estimatedUnitCostCents: cents.nullable().optional(),
    estimatedDropshipFeeCents: cents.nullable().optional(),
    terms: z.string().trim().max(2000).optional(),
    expiresAt: timestamp.nullable().optional(),
    comparison: provisionalComparisonSchema.optional(),
  })
  .strict();
export const reviewProposalSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    status: z.enum(["reviewing", "resolved", "rejected"]),
    sku: skuSchema.optional(),
    notes: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine(
    (value) => value.status !== "resolved" || Boolean(value.sku),
    "A resolved proposal requires a catalog SKU.",
  );

export type OfferInput = z.infer<typeof offerSchema>;
export type OfferVersion = Omit<OfferInput, "expectedVersion"> & {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
};
export type PolicyInput = z.infer<typeof policySchema>;
export type PolicyVersion = PolicyInput & {
  id: string;
  version: number;
  createdAt: string;
  createdBy: string;
};
export type RevenueProfile = Omit<
  z.infer<typeof revenueProfileSchema>,
  "expectedVersion"
> & { id: string; version: number; createdAt: string };
export type Scenario = z.infer<typeof scenarioSchema>;
export type Dependency = {
  offerId: string;
  version: number;
  expiresAt: string;
};
export type ResolvedScenario = {
  scenario: Scenario;
  input: PricingInput;
  evaluation: PricingEvaluation;
  dependencies: Dependency[];
  policyId: string;
  policyVersion: number;
};
export type Quote = ResolvedScenario & {
  id: string;
  revision: number;
  status: "draft" | "pending_approval" | "approved" | "bound";
  patientId: string | null;
  lines: Array<
    z.infer<typeof quoteLineSchema> & { unitCostCents: number | null }
  >;
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
      comparison?: PriceComparison;
      changeKind?: "selected" | "retained";
    }
  >;
  selectedEntryCount: number;
  retainedEntryCount: number;
  active: boolean;
  scheduledAt: string | null;
  scheduleStatus: "pending" | "applied" | "cancelled" | "blocked" | null;
  scheduleError: string | null;
};
export type PriceComparison = {
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
export type PortfolioItem = {
  sku: string;
  name: string;
  category: string | null;
  offers: OfferVersion[];
  hasMoreOffers: boolean;
  activeEntries: Array<{
    batchId: string;
    entryIndex: number;
    entry: ResolvedScenario;
    /** Current chosen suppliers for this portfolio row's SKU, including capped offers. */
    suppliers: Array<{ sku: string; offerId: string; supplierName: string }>;
  }>;
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
export type ActualEvent = z.infer<typeof actualSchema> & {
  id: string;
  createdAt: string;
};
export type Proposal = z.infer<typeof proposalSchema> & {
  comparisonResult?: ProvisionalComparisonResult;
  id: string;
  revision: number;
  status: "open" | "reviewing" | "resolved" | "rejected";
  sku: string | null;
  reviewNotes: string | null;
  createdAt: string;
};
export type PricingForecast = {
  status: "available" | "blocked";
  evaluation: PricingEvaluation | null;
  reason: string | null;
  evaluatedAt: string;
};
export type Reconciliation = {
  quote: Quote;
  events: ActualEvent[];
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
  forecast: PricingForecast;
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
