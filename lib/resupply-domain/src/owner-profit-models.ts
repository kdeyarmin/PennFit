import { z } from "zod";
import {
  evaluatePricing,
  recommendPricing,
  PricingValidationError,
  PRICING_MAX_CENTS,
  type PricingInput,
  type PricingEvaluation,
  type PricingIssue,
  type PricingRecommendation,
} from "./pricing";

const money = z.number().int().min(0).max(PRICING_MAX_CENTS);
const count = z.number().int().min(0).max(1_000_000);
const id = z.string().trim().min(1).max(160);
const changeBps = z.number().int().min(-10_000).max(100_000);

/** Each section is independently optional. Missing assumptions are never zero. */
export const ownerProfitAssumptionsSchema = z
  .object({
    selectedLineId: id.optional(),
    strategies: z
      .object({
        targetMarginBps: z.number().int().min(0).max(9_999).optional(),
        /** Markup on all variable costs, before allocated overhead.
         * Its conservative margin equivalent rounds up by less than one basis point. */
        markupBps: z.number().int().min(0).max(100_000).optional(),
        targetContributionCents: money.optional(),
        referenceUnitPriceCents: money.optional(),
      })
      .strict()
      .optional(),
    monthly: z
      .object({
        fixedCostCents: money.optional(),
        orders: count.optional(),
        targetProfitCents: money.optional(),
      })
      .strict()
      .optional(),
    sensitivity: z
      .object({
        cases: z
          .array(
            z
              .object({
                id,
                label: z.string().trim().max(120).optional(),
                goodsChangeBps: changeBps.optional(),
                freightChangeBps: changeBps.optional(),
                collectibleChangeBps: changeBps.optional(),
              })
              .strict(),
          )
          .max(12),
      })
      .strict()
      .optional(),
    priceVolume: z
      .object({
        fixedCostCents: money.optional(),
        cases: z
          .array(
            z
              .object({
                id,
                label: z.string().trim().max(120).optional(),
                unitPriceCents: money,
                orders: count,
              })
              .strict(),
          )
          .max(12),
      })
      .strict()
      .optional(),
    acquisition: z
      .object({
        horizonMonths: z.number().int().min(1).max(120).optional(),
        customers: count.optional(),
        ordersPerCustomer: z.number().int().min(0).max(10_000).optional(),
        acquisitionCostPerCustomerCents: money.optional(),
        retentionCostPerOrderCents: money.optional(),
        /** Total fixed costs across the whole stated horizon, not a monthly amount. */
        fixedCostCents: money.optional(),
      })
      .strict()
      .optional(),
    workingCapital: z
      .object({
        periodDays: z.number().int().min(1).max(366).optional(),
        orders: count.optional(),
        cashOutlayPerOrderCents: money.optional(),
        inventoryDays: z.number().int().min(0).max(3650).optional(),
        daysToCollect: z.number().int().min(0).max(3650).optional(),
        daysToPayVendor: z.number().int().min(0).max(3650).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["sensitivity", "priceVolume"] as const) {
      const seen = new Set<string>();
      value[key]?.cases.forEach((entry, index) => {
        if (seen.has(entry.id))
          context.addIssue({
            code: "custom",
            path: [key, "cases", index, "id"],
            message: "Each scenario needs a unique identifier.",
          });
        seen.add(entry.id);
      });
    }
  });
export type OwnerProfitAssumptions = z.infer<
  typeof ownerProfitAssumptionsSchema
>;
export type OwnerModelStatus =
  | "calculated"
  | "estimated"
  | "needs_inputs"
  | "unattainable"
  | "not_applicable"
  | "blocked";
export interface OwnerModelResult {
  status: OwnerModelStatus;
  issues: PricingIssue[];
}
export interface OwnerStrategyResult extends OwnerModelResult {
  strategy:
    | "target_margin"
    | "cost_markup"
    | "fixed_contribution"
    | "reference_price";
  lineId: string | null;
  unitPriceCents: number | null;
  evaluation: PricingEvaluation | null;
  recommendationStatus: PricingRecommendation["status"] | null;
  equivalentTargetMarginBps: number | null;
}
export interface OwnerScenarioResult extends OwnerModelResult {
  id: string;
  label: string;
  evaluation: PricingEvaluation | null;
  contributionDeltaCents: number | null;
}
export interface OwnerPriceVolumeResult extends OwnerScenarioResult {
  orders: number;
  projectedRevenueCents: number | null;
  projectedContributionCents: number | null;
  projectedProfitCents: number | null;
}
export interface OwnerProfitModels {
  modelVersion: "1";
  evaluatedAt: string;
  currency: "USD";
  /** All planning starts before allocated overhead; explicit fixed costs subtract once. */
  overheadTreatment: "explicit_fixed_costs_replace_allocated_overhead";
  baseline: PricingEvaluation;
  strategies: {
    status: OwnerModelStatus;
    issues: PricingIssue[];
    items: OwnerStrategyResult[];
  };
  monthly: OwnerModelResult & {
    contributionPerOrderCents: number | null;
    breakEvenOrders: number | null;
    targetProfitOrders: number | null;
    projectedRevenueCents: number | null;
    projectedContributionCents: number | null;
    projectedProfitCents: number | null;
  };
  sensitivity: {
    status: OwnerModelStatus;
    issues: PricingIssue[];
    items: OwnerScenarioResult[];
  };
  priceVolume: {
    status: OwnerModelStatus;
    issues: PricingIssue[];
    items: OwnerPriceVolumeResult[];
  };
  acquisition: OwnerModelResult & {
    horizonMonths: number | null;
    totalOrders: number | null;
    contributionPerCustomerCents: number | null;
    netPerCustomerCents: number | null;
    totalAcquisitionCostCents: number | null;
    projectedProfitCents: number | null;
    acquisitionPaybackOrders: number | null;
    paybackWithinHorizon: boolean | null;
  };
  workingCapital: OwnerModelResult & {
    fundingGapDays: number | null;
    periodCashOutlayCents: number | null;
    estimatedFundingCents: number | null;
  };
}

const issue = (code: string, path: string, message: string): PricingIssue => ({
  code,
  path,
  message,
});
const missing = (path: string): OwnerModelResult => ({
  status: "needs_inputs",
  issues: [
    issue(
      "missing_assumption",
      path,
      "Enter the assumptions for this model; blank values are not zero.",
    ),
  ],
});
const unsupported = (path: string, message: string): OwnerModelResult => ({
  status: "not_applicable",
  issues: [issue("fixed_revenue", path, message)],
});
function checked(value: bigint, path: string): number {
  if (value > BigInt(PRICING_MAX_CENTS) || value < -BigInt(PRICING_MAX_CENTS))
    throw new PricingValidationError([
      issue(
        "amount_out_of_range",
        path,
        "This projection exceeds the supported amount limit.",
      ),
    ]);
  return Number(value);
}
const multiply = (amount: number, count: number, path: string) =>
  checked(BigInt(amount) * BigInt(count), path);
const subtract = (left: number, right: number, path: string) =>
  checked(BigInt(left) - BigInt(right), path);
const ceil = (numerator: bigint, denominator: bigint, path: string) =>
  checked((numerator + denominator - 1n) / denominator, path);
const changed = (amount: number, bps: number, path: string) =>
  checked((BigInt(amount) * BigInt(10_000 + bps) + 5_000n) / 10_000n, path);
function problem(error: unknown, path: string): OwnerModelResult {
  if (!(error instanceof PricingValidationError)) throw error;
  return {
    status: "blocked",
    issues: error.issues.map((entry) => ({
      ...entry,
      path: `${path}.${entry.path}`,
    })),
  };
}
function quality(evaluation: PricingEvaluation): OwnerModelResult {
  if (
    !evaluation.calculationComplete ||
    evaluation.issues.some(
      (entry) => entry.code === "missing_input" || entry.code === "stale_input",
    )
  )
    return {
      status: "needs_inputs",
      issues: evaluation.issues.length
        ? [...evaluation.issues]
        : [
            issue(
              "incomplete_scenario",
              "scenario",
              "Complete the cost and revenue evidence before projecting profit.",
            ),
          ],
    };
  return {
    status: evaluation.costsComplete ? "calculated" : "estimated",
    issues: [...evaluation.issues],
  };
}
function group<T extends OwnerModelResult>(
  items: T[],
): OwnerModelResult & { items: T[] } {
  if (!items.length) return { ...missing("assumptions"), items };
  const available = items.filter(
    (item) => item.status === "calculated" || item.status === "estimated",
  );
  return {
    status: available.length
      ? available.some((item) => item.status === "estimated")
        ? "estimated"
        : "calculated"
      : ((
          ["blocked", "unattainable", "not_applicable", "needs_inputs"] as const
        ).find((status) => items.some((item) => item.status === status)) ??
        "needs_inputs"),
    issues: available.length ? [] : items.flatMap((item) => item.issues),
    items,
  };
}
function selectedLine(input: PricingInput, selected?: string) {
  return selected
    ? input.lines.find((line) => line.id === selected)
    : input.lines.length === 1
      ? input.lines[0]
      : undefined;
}
function ceilingIssue(
  input: PricingInput,
  amount: number,
): OwnerModelResult | null {
  return input.policy.priceCeilingCents !== undefined &&
    amount > input.policy.priceCeilingCents
    ? {
        status: "blocked",
        issues: [
          issue(
            "price_ceiling_exceeded",
            "unitPriceCents",
            "This amount exceeds the policy price ceiling.",
          ),
        ],
      }
    : null;
}
function modelEvaluation(evaluation: PricingEvaluation): OwnerModelResult {
  const result = quality(evaluation);
  if (result.status === "needs_inputs") return result;
  if (
    evaluation.meetsFloor === false ||
    evaluation.meetsLineFloors === false ||
    evaluation.meetsMinimumContribution === false
  )
    return {
      status: "blocked",
      issues: [
        ...result.issues,
        issue(
          "policy_floor",
          "scenario.policy",
          "This hypothetical scenario fails a policy floor or minimum contribution.",
        ),
      ],
    };
  return result;
}

/** Internal decision support only. Never approves, saves or publishes a price. */
export function analyzeOwnerProfitModels(
  input: PricingInput,
  rawAssumptions: OwnerProfitAssumptions,
): OwnerProfitModels {
  const parsed = ownerProfitAssumptionsSchema.safeParse(rawAssumptions);
  if (!parsed.success)
    throw new PricingValidationError(
      parsed.error.issues.map((entry) =>
        issue("invalid_assumption", entry.path.join("."), entry.message),
      ),
    );
  const assumptions = parsed.data;
  const baseline = evaluatePricing(input);
  const baselineQuality = quality(baseline);
  const usable =
    baselineQuality.status === "calculated" ||
    baselineQuality.status === "estimated";
  const selected = selectedLine(input, assumptions.selectedLineId);
  const hardPolicy = {
    ...input.policy,
    targetMarginBps: input.policy.floorMarginBps,
  };
  let hardRecommendation: PricingRecommendation | undefined;
  const selectionError: OwnerModelResult = {
    status: "needs_inputs",
    issues: [
      issue(
        "selection_required",
        "selectedLineId",
        "Select one existing item to change its unit price while keeping the other items fixed.",
      ),
    ],
  };
  const strategyNames = [
    "target_margin",
    "cost_markup",
    "fixed_contribution",
    "reference_price",
  ] as const;
  const values = [
    assumptions.strategies?.targetMarginBps,
    assumptions.strategies?.markupBps,
    assumptions.strategies?.targetContributionCents,
    assumptions.strategies?.referenceUnitPriceCents,
  ];
  const strategies = strategyNames.map(
    (strategy, index): OwnerStrategyResult => {
      const empty = {
        strategy,
        lineId: selected?.id ?? null,
        unitPriceCents: null,
        evaluation: null,
        recommendationStatus: null,
        equivalentTargetMarginBps: null,
      };
      const value = values[index];
      if (value === undefined)
        return { ...empty, ...missing(`strategies.${strategy}`) };
      if (input.revenue.mode === "insurance")
        return {
          ...empty,
          ...unsupported(
            "strategies",
            "Insurance collections are fixed evidence; unit-price strategies apply only to internal self-pay scenarios.",
          ),
        };
      if (!selected) return { ...empty, ...selectionError };
      if (!usable) return { ...empty, ...baselineQuality };
      try {
        if (strategy === "reference_price") {
          const next = {
            ...input,
            lines: input.lines.map((line) =>
              line.id === selected.id
                ? { ...line, unitPriceCents: value }
                : line,
            ),
          };
          const evaluation = evaluatePricing(next);
          return {
            ...empty,
            ...modelEvaluation(evaluation),
            ...(ceilingIssue(input, value) ?? {}),
            unitPriceCents: value,
            evaluation,
          };
        }
        // Three owner searches and at most one cached original-policy hard-floor
        // search, all bounded by the existing recommendation engine.
        // Large baskets can still use explicit reference/sensitivity/volume cases.
        if (
          input.lines.length +
            input.costs.length +
            (input.processing?.chargeAmountsCents?.length ?? 0) >
          160
        )
          return {
            ...empty,
            status: "blocked",
            issues: [
              issue(
                "scenario_too_large",
                "strategies",
                "Use an explicit reference price for this large basket; automated strategy search is bounded to 160 input components.",
              ),
            ],
          };
        const markupMargin =
          strategy === "cost_markup"
            ? Number(
                (BigInt(value) * 10_000n + BigInt(10_000 + value) - 1n) /
                  BigInt(10_000 + value),
              )
            : null;
        const target =
          strategy === "target_margin"
            ? value
            : (markupMargin ?? input.policy.floorMarginBps);
        const policy = {
          ...input.policy,
          basis: "contribution" as const,
          targetMarginBps: Math.max(target, input.policy.floorMarginBps),
          minimumContributionCents:
            strategy === "fixed_contribution"
              ? Math.max(value, input.policy.minimumContributionCents ?? 0)
              : input.policy.minimumContributionCents,
        };
        const recommendation = recommendPricing(
          { ...input, policy },
          selected.id,
        );
        if (
          !recommendation.recommendedInput ||
          recommendation.recommendedUnitPriceCents === null
        )
          return {
            ...empty,
            status:
              recommendation.status === "cost_information_needed" ||
              recommendation.status === "selection_required"
                ? "needs_inputs"
                : "unattainable",
            issues: [
              issue(
                recommendation.status,
                `strategies.${strategy}`,
                "No verified unit amount can be recommended under these assumptions and policy constraints.",
              ),
            ],
            recommendationStatus: recommendation.status,
            equivalentTargetMarginBps: markupMargin,
          };
        let unitPriceCents = recommendation.recommendedUnitPriceCents;
        if (input.policy.basis === "after_overhead") {
          hardRecommendation ??= recommendPricing(
            { ...input, policy: hardPolicy },
            selected.id,
          );
          if (hardRecommendation.recommendedUnitPriceCents === null)
            return {
              ...empty,
              status: "unattainable",
              recommendationStatus: hardRecommendation.status,
              equivalentTargetMarginBps: markupMargin,
              issues: [
                issue(
                  hardRecommendation.status,
                  `strategies.${strategy}`,
                  "No amount satisfies the original policy hard floors under these assumptions.",
                ),
              ],
            };
          unitPriceCents = Math.max(
            unitPriceCents,
            hardRecommendation.recommendedUnitPriceCents,
          );
        }
        const candidate: PricingInput = {
          ...input,
          lines: input.lines.map((line) =>
            line.id === selected.id ? { ...line, unitPriceCents } : line,
          ),
        };
        // Fee rounding and allocated item floors can be non-monotonic. Never
        // assume the larger independently recommended amount passes both goals.
        if (
          evaluatePricing({ ...candidate, policy }).state !== "meets_target" ||
          evaluatePricing({ ...candidate, policy: hardPolicy }).state !==
            "meets_target"
        )
          return {
            ...empty,
            status: "blocked",
            recommendationStatus: "no_qualifying_price",
            equivalentTargetMarginBps: markupMargin,
            issues: [
              issue(
                "joint_policy_review_required",
                `strategies.${strategy}`,
                "The bounded recommendation does not satisfy both the owner goal and original hard floors; review an explicit reference price.",
              ),
            ],
          };
        const evaluation = evaluatePricing(candidate);
        // A meaningful percentage markup needs positive net variable costs.
        // Recoveries or rounded percentage fees can make that denominator
        // nonpositive at the candidate even when the original cost was positive.
        // Preserve its economics for review, but do not claim a markup price.
        if (
          strategy === "cost_markup" &&
          evaluation.totalVariableCostCents !== null &&
          evaluation.totalVariableCostCents <= 0
        )
          return {
            ...empty,
            status: "not_applicable",
            evaluation,
            issues: [
              issue(
                "nonpositive_markup_cost",
                "strategies.cost_markup",
                "A percentage markup requires positive net variable costs. Recoveries or rounded fees leave this candidate without a positive cost base; review a reference price or a contribution target instead.",
              ),
            ],
          };
        return {
          ...empty,
          ...modelEvaluation(evaluation),
          unitPriceCents,
          evaluation,
          recommendationStatus: recommendation.status,
          equivalentTargetMarginBps: markupMargin,
        };
      } catch (error) {
        return { ...empty, ...problem(error, `strategies.${strategy}`) };
      }
    },
  );

  const monthlyEmpty = {
    contributionPerOrderCents: baseline.contributionCents,
    breakEvenOrders: null,
    targetProfitOrders: null,
    projectedRevenueCents: null,
    projectedContributionCents: null,
    projectedProfitCents: null,
  };
  let monthly: OwnerProfitModels["monthly"] = {
    ...monthlyEmpty,
    ...missing("monthly"),
  };
  const m = assumptions.monthly;
  if (
    m?.fixedCostCents !== undefined &&
    m.orders !== undefined &&
    m.targetProfitCents !== undefined
  ) {
    monthly = { ...monthlyEmpty, ...baselineQuality };
    if (usable)
      try {
        const contribution = baseline.contributionCents!;
        const projectedContribution = multiply(
          contribution,
          m.orders,
          "monthly.contribution",
        );
        const required = BigInt(m.fixedCostCents) + BigInt(m.targetProfitCents);
        monthly = {
          ...monthly,
          projectedRevenueCents: multiply(
            baseline.netRevenueCents!,
            m.orders,
            "monthly.revenue",
          ),
          projectedContributionCents: projectedContribution,
          projectedProfitCents: subtract(
            projectedContribution,
            m.fixedCostCents,
            "monthly.profit",
          ),
          breakEvenOrders:
            m.fixedCostCents === 0
              ? 0
              : contribution > 0
                ? ceil(
                    BigInt(m.fixedCostCents),
                    BigInt(contribution),
                    "monthly.breakEvenOrders",
                  )
                : null,
          targetProfitOrders:
            required === 0n
              ? 0
              : contribution > 0
                ? ceil(
                    required,
                    BigInt(contribution),
                    "monthly.targetProfitOrders",
                  )
                : null,
        };
        if (contribution <= 0 && required > 0n)
          monthly = {
            ...monthly,
            status: "unattainable",
            issues: [
              issue(
                "nonpositive_contribution",
                "monthly",
                "Additional orders cannot cover positive fixed costs or target profit at this contribution.",
              ),
            ],
          };
      } catch (error) {
        monthly = { ...monthlyEmpty, ...problem(error, "monthly") };
      }
  }

  const sensitivity = (assumptions.sensitivity?.cases ?? []).map(
    (change): OwnerScenarioResult => {
      const empty = {
        id: change.id,
        label: change.label ?? change.id,
        evaluation: null,
        contributionDeltaCents: null,
      };
      if (
        change.goodsChangeBps === undefined &&
        change.freightChangeBps === undefined &&
        change.collectibleChangeBps === undefined
      )
        return { ...empty, ...missing(`sensitivity.${change.id}`) };
      if (!usable) return { ...empty, ...baselineQuality };
      if (
        change.collectibleChangeBps !== undefined &&
        input.revenue.mode !== "insurance"
      )
        return {
          ...empty,
          ...unsupported(
            `sensitivity.${change.id}`,
            "Collection sensitivity requires a fixed insurance collectible scenario.",
          ),
        };
      const freight = input.costs.filter(
        (cost) => cost.category === "freight" || cost.category === "shipping",
      );
      const freightParents = new Set(
        freight.filter((cost) => !cost.includedInId).map((cost) => cost.id),
      );
      const components = new Map(input.costs.map((cost) => [cost.id, cost]));
      const bundledInOtherCosts = freight.some((cost) => {
        let parent = cost;
        // evaluatePricing already validated every reference and rejected cycles.
        // An included alias is safe only when its ultimate priced parent is
        // itself freight; goods or a mixed non-freight charge is not separable.
        while (parent.includedInId) {
          const next = components.get(parent.includedInId);
          if (!next) return true;
          parent = next;
        }
        return !freightParents.has(parent.id);
      });
      if (
        change.freightChangeBps !== undefined &&
        (!freight.length || bundledInOtherCosts)
      )
        return {
          ...empty,
          status: "needs_inputs",
          issues: [
            issue(
              "freight_scope_needed",
              `sensitivity.${change.id}`,
              "Provide separate freight evidence; an included delivery amount cannot be independently changed without changing its parent cost.",
            ),
          ],
        };
      try {
        const next: PricingInput = {
          ...input,
          lines: input.lines.map((line) =>
            change.goodsChangeBps === undefined || line.unitCostCents === null
              ? line
              : {
                  ...line,
                  costStatus: "estimated",
                  unitCostCents: changed(
                    line.unitCostCents,
                    change.goodsChangeBps,
                    "goodsChangeBps",
                  ),
                },
          ),
          costs: input.costs.map((cost) =>
            change.freightChangeBps === undefined ||
            cost.amountCents === null ||
            !freightParents.has(cost.id)
              ? cost
              : {
                  ...cost,
                  status: "estimated",
                  amountCents: changed(
                    cost.amountCents,
                    change.freightChangeBps,
                    "freightChangeBps",
                  ),
                },
          ),
          revenue:
            input.revenue.mode === "insurance" &&
            input.revenue.expectedCollectibleCents !== null &&
            change.collectibleChangeBps !== undefined
              ? {
                  ...input.revenue,
                  status: "estimated",
                  expectedCollectibleCents: changed(
                    input.revenue.expectedCollectibleCents,
                    change.collectibleChangeBps,
                    "collectibleChangeBps",
                  ),
                }
              : input.revenue,
        };
        const evaluation = evaluatePricing(next);
        return {
          ...empty,
          ...modelEvaluation(evaluation),
          evaluation,
          contributionDeltaCents:
            evaluation.contributionCents === null
              ? null
              : subtract(
                  evaluation.contributionCents,
                  baseline.contributionCents!,
                  "sensitivity.delta",
                ),
        };
      } catch (error) {
        return { ...empty, ...problem(error, `sensitivity.${change.id}`) };
      }
    },
  );

  const priceVolume = (assumptions.priceVolume?.cases ?? []).map(
    (volume): OwnerPriceVolumeResult => {
      const empty = {
        id: volume.id,
        label: volume.label ?? volume.id,
        orders: volume.orders,
        evaluation: null,
        contributionDeltaCents: null,
        projectedRevenueCents: null,
        projectedContributionCents: null,
        projectedProfitCents: null,
      };
      if (input.revenue.mode === "insurance")
        return {
          ...empty,
          ...unsupported(
            "priceVolume",
            "Insurance collectible revenue is fixed; use the monthly model for insurance volume planning.",
          ),
        };
      if (!selected) return { ...empty, ...selectionError };
      if (!usable) return { ...empty, ...baselineQuality };
      if (assumptions.priceVolume?.fixedCostCents === undefined)
        return { ...empty, ...missing("priceVolume.fixedCostCents") };
      try {
        const next = {
          ...input,
          lines: input.lines.map((line) =>
            line.id === selected.id
              ? { ...line, unitPriceCents: volume.unitPriceCents }
              : line,
          ),
        };
        const evaluation = evaluatePricing(next);
        if (!evaluation.calculationComplete)
          return { ...empty, ...quality(evaluation), evaluation };
        const projectedContributionCents = multiply(
          evaluation.contributionCents!,
          volume.orders,
          "priceVolume.contribution",
        );
        return {
          ...empty,
          ...modelEvaluation(evaluation),
          ...(ceilingIssue(input, volume.unitPriceCents) ?? {}),
          evaluation,
          contributionDeltaCents: subtract(
            evaluation.contributionCents!,
            baseline.contributionCents!,
            "priceVolume.delta",
          ),
          projectedContributionCents,
          projectedRevenueCents: multiply(
            evaluation.netRevenueCents!,
            volume.orders,
            "priceVolume.revenue",
          ),
          projectedProfitCents: subtract(
            projectedContributionCents,
            assumptions.priceVolume.fixedCostCents,
            "priceVolume.profit",
          ),
        };
      } catch (error) {
        return { ...empty, ...problem(error, `priceVolume.${volume.id}`) };
      }
    },
  );

  const acquisitionEmpty = {
    horizonMonths: assumptions.acquisition?.horizonMonths ?? null,
    totalOrders: null,
    contributionPerCustomerCents: null,
    netPerCustomerCents: null,
    totalAcquisitionCostCents: null,
    projectedProfitCents: null,
    acquisitionPaybackOrders: null,
    paybackWithinHorizon: null,
  };
  let acquisition: OwnerProfitModels["acquisition"] = {
    ...acquisitionEmpty,
    ...missing("acquisition"),
  };
  const a = assumptions.acquisition;
  if (
    a?.horizonMonths !== undefined &&
    a.customers !== undefined &&
    a.ordersPerCustomer !== undefined &&
    a.acquisitionCostPerCustomerCents !== undefined &&
    a.retentionCostPerOrderCents !== undefined &&
    a.fixedCostCents !== undefined
  ) {
    acquisition = { ...acquisitionEmpty, ...baselineQuality };
    if (usable)
      try {
        const netPerOrder = subtract(
          baseline.contributionCents!,
          a.retentionCostPerOrderCents,
          "acquisition.netPerOrder",
        );
        const contributionPerCustomer = multiply(
          baseline.contributionCents!,
          a.ordersPerCustomer,
          "acquisition.contributionPerCustomer",
        );
        const netPerCustomer = subtract(
          multiply(
            netPerOrder,
            a.ordersPerCustomer,
            "acquisition.netPerCustomer",
          ),
          a.acquisitionCostPerCustomerCents,
          "acquisition.netPerCustomer",
        );
        const paybackOrders =
          a.acquisitionCostPerCustomerCents === 0
            ? 0
            : netPerOrder > 0
              ? ceil(
                  BigInt(a.acquisitionCostPerCustomerCents),
                  BigInt(netPerOrder),
                  "acquisition.paybackOrders",
                )
              : null;
        acquisition = {
          ...acquisition,
          totalOrders: multiply(
            a.customers,
            a.ordersPerCustomer,
            "acquisition.totalOrders",
          ),
          contributionPerCustomerCents: contributionPerCustomer,
          netPerCustomerCents: netPerCustomer,
          totalAcquisitionCostCents: multiply(
            a.acquisitionCostPerCustomerCents,
            a.customers,
            "acquisition.acquisitionSpend",
          ),
          projectedProfitCents: subtract(
            multiply(
              netPerCustomer,
              a.customers,
              "acquisition.netAllCustomers",
            ),
            a.fixedCostCents,
            "acquisition.profit",
          ),
          acquisitionPaybackOrders: paybackOrders,
          paybackWithinHorizon:
            paybackOrders !== null && paybackOrders <= a.ordersPerCustomer,
        };
        if (paybackOrders === null)
          acquisition = {
            ...acquisition,
            status: "unattainable",
            issues: [
              issue(
                "nonpositive_contribution",
                "acquisition",
                "Contribution after per-order retention cost cannot repay acquisition spending.",
              ),
            ],
          };
      } catch (error) {
        acquisition = { ...acquisitionEmpty, ...problem(error, "acquisition") };
      }
  }

  const capitalEmpty = {
    fundingGapDays: null,
    periodCashOutlayCents: null,
    estimatedFundingCents: null,
  };
  let workingCapital: OwnerProfitModels["workingCapital"] = {
    ...capitalEmpty,
    ...missing("workingCapital"),
  };
  const w = assumptions.workingCapital;
  if (
    w?.periodDays !== undefined &&
    w.orders !== undefined &&
    w.cashOutlayPerOrderCents !== undefined &&
    w.inventoryDays !== undefined &&
    w.daysToCollect !== undefined &&
    w.daysToPayVendor !== undefined
  )
    try {
      const fundingGapDays = Math.max(
        w.inventoryDays + w.daysToCollect - w.daysToPayVendor,
        0,
      );
      const periodCashOutlayCents = multiply(
        w.cashOutlayPerOrderCents,
        w.orders,
        "workingCapital.cashOutlay",
      );
      workingCapital = {
        status: "estimated",
        issues: [],
        fundingGapDays,
        periodCashOutlayCents,
        estimatedFundingCents: ceil(
          BigInt(periodCashOutlayCents) * BigInt(fundingGapDays),
          BigInt(w.periodDays),
          "workingCapital.funding",
        ),
      };
    } catch (error) {
      workingCapital = { ...capitalEmpty, ...problem(error, "workingCapital") };
    }

  return {
    modelVersion: "1",
    evaluatedAt: input.evaluatedAt,
    currency: "USD",
    overheadTreatment: "explicit_fixed_costs_replace_allocated_overhead",
    baseline,
    strategies: group(strategies),
    monthly,
    sensitivity: group(sensitivity),
    priceVolume: group(priceVolume),
    acquisition,
    workingCapital,
  };
}
