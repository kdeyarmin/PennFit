import { z } from "zod";

const DAY = 86_400_000;
const integer = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const count = integer.min(0);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  }, "Enter a real calendar date.");

export const ownerAnalyticsQuerySchema = z
  .object({
    days: z
      .union([z.number(), z.string()])
      .pipe(
        z.coerce
          .number<string | number>()
          .int()
          .refine((value) => [7, 30, 90, 365].includes(value)),
      )
      .optional(),
    from: day.optional(),
    to: day.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Boolean(value.from) !== Boolean(value.to) ||
      (value.days !== undefined && value.from !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Choose a preset or provide both dates.",
      });
  });

export type OwnerAnalyticsQuery = z.infer<typeof ownerAnalyticsQuerySchema>;
export interface OwnerAnalyticsWindow {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

/** UTC and half-open. Today's custom end stops at now; comparisons have
 * exactly the same elapsed duration rather than a partial vs full day. */
export function ownerAnalyticsWindow(
  query: OwnerAnalyticsQuery,
  now: Date,
): OwnerAnalyticsWindow {
  const input = ownerAnalyticsQuerySchema.parse(query);
  const endNow = now.getTime();
  if (!Number.isFinite(endNow)) throw new Error("invalid_clock");
  let from: number;
  let to: number;
  if (input.from && input.to) {
    from = Date.parse(`${input.from}T00:00:00.000Z`);
    const endDay = Date.parse(`${input.to}T00:00:00.000Z`);
    if (
      endDay < from ||
      input.to > now.toISOString().slice(0, 10) ||
      endDay - from >= 366 * DAY
    )
      throw new Error("invalid_date_range");
    to = Math.min(endDay + DAY, endNow);
  } else {
    to = endNow;
    from = to - (input.days ?? 30) * DAY;
  }
  if (to <= from || to - from > 366 * DAY)
    throw new Error("invalid_date_range");
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    previousFrom: new Date(from - (to - from)).toISOString(),
    previousTo: new Date(from).toISOString(),
  };
}

export const ownerBusinessPeriodSchema = z.object({
  patientsAdded: count,
  orderRequestsCreated: count,
  orderRequestsSigned: count,
  episodesOpened: count,
  episodesConfirmed: count,
  episodesFulfilled: count,
  episodesAssumedShipped: count,
  fulfillmentLinesQueued: count,
  unitsQueued: count,
  shipmentLinesRecorded: count,
  patientsServed: count,
  returningPatientsServed: count,
  claimsCreated: count,
  claimBilledCents: count,
  claimPaidToDateCents: count,
  fitRequestsCreated: count,
  fitRequestsFulfilled: count,
  outboundMessages: count,
  inboundMessages: count,
  deliveredMessages: count,
  failedMessages: count,
});
export type OwnerBusinessPeriod = z.infer<typeof ownerBusinessPeriodSchema>;

export const ownerBusinessAnalyticsSchema = z.object({
  current: ownerBusinessPeriodSchema,
  previous: ownerBusinessPeriodSchema,
  snapshot: z.object({
    activePatients: count,
    pausedPatients: count,
    openConversations: count,
    awaitingStaffConversations: count,
    unassignedConversations: count,
    overdueSlaConversations: count,
    dueResupplyPatients: count,
    dueSoonResupplyPatients: count,
    addressHoldEpisodes: count,
    pendingSignatures: count,
    expiredSignatures: count,
    unbilledShipmentLines: count,
    draftClaims: count,
    deniedClaims: count,
    unacknowledgedClaims: count,
    openClaims: count,
    openClaimBilledCents: count,
    openClaimPaidCents: count,
    openFitRequests: count,
    activeProducts: count,
    trackedProducts: count,
    untrackedProducts: count,
    lowStockProducts: count,
    outOfStockProducts: count,
  }),
  daily: z
    .array(
      z.object({
        date: day,
        orderRequestsCreated: count,
        orderRequestsSigned: count,
        episodesOpened: count,
        shipmentLinesRecorded: count,
        patientsAdded: count,
      }),
    )
    .max(367),
  orderRequestStages: z
    .array(z.object({ status: z.string().max(64), count }))
    .max(20),
  resupplyStages: z
    .array(z.object({ status: z.string().max(64), count }))
    .max(20),
  claimStages: z
    .array(
      z.object({
        status: z.string().max(64),
        count,
        billedCents: count,
        paidCents: count,
      }),
    )
    .max(20),
  claimAging: z
    .array(
      z.object({
        bucket: z.enum(["0_30", "31_60", "61_90", "over_90"]),
        count,
        billedCents: count,
        paidCents: count,
      }),
    )
    .max(4),
  payers: z
    .array(
      z.object({
        payer: z.string().max(300),
        claims: count,
        billedCents: count,
        paidCents: count,
        deniedClaims: count,
      }),
    )
    .max(10),
  topProducts: z
    .array(
      z.object({
        sku: z.string().max(300),
        name: z.string().max(1000).nullable(),
        units: count,
        fulfillmentLines: count,
      }),
    )
    .max(10),
  lowStock: z
    .array(
      z.object({
        sku: z.string().max(300),
        name: z.string().max(1000).nullable(),
        stockCount: integer,
        threshold: count,
      }),
    )
    .max(10),
  outreachChannels: z
    .array(
      z.object({
        channel: z.string().max(64),
        inbound: count,
        outbound: count,
        delivered: count,
        failed: count,
      }),
    )
    .max(20),
});
export type OwnerBusinessAnalytics = z.infer<
  typeof ownerBusinessAnalyticsSchema
>;

const financialPeriodSchema = z.object({
  revenueCents: integer,
  costCents: integer,
  eventCount: count,
  revenueEventCount: count,
  costEventCount: count,
  quoteCount: count,
});
export const ownerFinancialAnalyticsSchema = z.object({
  current: financialPeriodSchema,
  previous: financialPeriodSchema,
  settled: z.object({
    boundOrders: count,
    settledOrders: count,
    incompleteOrders: count,
    uncertainOrders: count,
    costsIncompleteOrders: count,
    revenueIncompleteOrders: count,
    netRevenueCents: integer,
    netCostCents: integer,
    contributionCents: integer,
  }),
  quality: z.object({ undatedEvents: count, futureDatedEvents: count }),
  pricing: z.object({
    pendingApprovals: count,
    openProposals: count,
    enabled: z.boolean(),
    enforceQuotes: z.boolean(),
    policyConfigured: z.boolean(),
    activePriceListConfigured: z.boolean(),
  }),
  daily: z
    .array(
      z.object({
        date: day,
        revenueCents: integer,
        costCents: integer,
        eventCount: count,
      }),
    )
    .max(367),
  costSources: z
    .array(
      z.object({
        source: z.string().max(64),
        costCents: integer,
        eventCount: count,
      }),
    )
    .max(20),
});
export type OwnerFinancialAnalytics = z.infer<
  typeof ownerFinancialAnalyticsSchema
>;

export type OwnerAnalyticsSection<T> =
  | { status: "available"; data: T }
  | { status: "unavailable"; message: string };

export interface OwnerAnalyticsResponse {
  generatedAt: string;
  window: OwnerAnalyticsWindow;
  business: OwnerAnalyticsSection<OwnerBusinessAnalytics>;
  financial: OwnerAnalyticsSection<OwnerFinancialAnalytics>;
}

/** Relative movement, not a promise about performance. A zero previous
 * denominator has no percentage change; callers display absolute values. */
export function ownerAnalyticsChange(
  current: number,
  previous: number,
): number | null {
  return previous === 0
    ? null
    : ((current - previous) / Math.abs(previous)) * 100;
}
