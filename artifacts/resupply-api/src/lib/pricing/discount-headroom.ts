import { setImmediate } from "node:timers/promises";
import {
  evaluatePricing,
  type PricingEvaluation,
} from "@workspace/resupply-domain";
import type { ResolvedScenario } from "./contracts";

export interface DiscountHeadroom {
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
}

/** Exact within the returned finite interval. Rounded captures and allocation
 * floors need not be monotone, so every candidate cent is evaluated. Quantities,
 * supplier tiers, destination/service, billed prices and fee assumptions stay fixed. */
export async function calculateDiscountHeadroom(
  resolved: ResolvedScenario,
  requestedUpperBoundCents = 100_000,
): Promise<DiscountHeadroom> {
  const { input, evaluation } = resolved;
  const result: DiscountHeadroom = {
    status: "calculated",
    searchUpperBoundCents: 0,
    remainingMerchandiseCents: evaluation.merchandiseRevenueCents,
    wholeDomainSearched: false,
    target: null,
    floor: null,
  };
  if (input.revenue.mode !== "self_pay")
    return { ...result, status: "self_pay_required" };
  if (!evaluation.costsComplete || !evaluation.calculationComplete)
    return { ...result, status: "cost_information_needed" };
  if (
    evaluation.issues.some((issue) => issue.code === "price_ceiling_exceeded")
  )
    return { ...result, status: "blocked_policy" };
  if (
    input.processing?.chargeAmountsCents &&
    input.processing.basis !== "explicit"
  )
    return { ...result, status: "fixed_capture_amounts" };

  // Bound synchronous work even for many lines, components and captures. Yield
  // between short chunks so ordinary API requests continue to make progress.
  const workPerCandidate = Math.max(
    1,
    input.lines.length +
      input.costs.length +
      (input.processing?.chargeAmountsCents?.length ??
        input.processing?.chargeCount ??
        1),
  );
  const currentFixedDiscount = input.revenue.discountCents ?? 0;
  const upper = Math.max(
    0,
    Math.min(
      evaluation.merchandiseRevenueCents,
      requestedUpperBoundCents,
      100_000,
      100_000_000 - currentFixedDiscount,
      Math.floor(250_000 / workPerCandidate),
    ),
  );
  result.searchUpperBoundCents = upper;
  result.wholeDomainSearched = upper === evaluation.merchandiseRevenueCents;
  result.status = result.wholeDomainSearched ? "calculated" : "search_limit";
  for (let additional = 0; additional <= upper; additional++) {
    if (additional > 0 && additional % 128 === 0) await setImmediate();
    const candidate = evaluatePricing({
      ...input,
      revenue: {
        ...input.revenue,
        discountCents: currentFixedDiscount + additional,
      },
    });
    if (
      candidate.meetsFloor &&
      candidate.meetsLineFloors &&
      candidate.meetsMinimumContribution
    ) {
      result.floor = {
        additionalDiscountCents: additional,
        evaluation: candidate,
      };
      if (candidate.meetsTarget)
        result.target = {
          additionalDiscountCents: additional,
          evaluation: candidate,
        };
    }
  }
  return result;
}
