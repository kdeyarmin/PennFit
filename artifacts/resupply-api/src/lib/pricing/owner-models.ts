import {
  analyzeOwnerProfitModels,
  type OwnerModelResult,
  type OwnerModelStatus,
  type OwnerProfitAssumptions,
  type OwnerProfitModels,
  type PricingEvaluation,
  type PricingIssue,
  type PricingPolicy,
} from "@workspace/resupply-domain";
import type { ResolvedScenario } from "./contracts";
import { PricingError } from "./service";

type PolicyApplication = { lineId: string; rules: PricingPolicy };

function combineIssues(...groups: PricingIssue[][]): PricingIssue[] {
  const seen = new Set<string>();
  return groups.flat().filter((issue) => {
    const key = `${issue.code}:${issue.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function regroup<T extends OwnerModelResult>(items: T[]) {
  const available = items.filter(
    (item) => item.status === "calculated" || item.status === "estimated",
  );
  const status: OwnerModelStatus = available.length
    ? available.some((item) => item.status === "estimated")
      ? "estimated"
      : "calculated"
    : ((
        ["blocked", "unattainable", "not_applicable", "needs_inputs"] as const
      ).find((status) => items.some((item) => item.status === status)) ??
      "needs_inputs");
  return {
    status,
    issues: available.length
      ? []
      : combineIssues(...items.map((item) => item.issues)),
    items,
  };
}

/** The aggregate order policy intentionally has no multi-item price ceiling.
 * Reapply each item's resolved rules before presenting owner alternatives. */
export function analyzeResolvedOwnerProfitModels(
  resolved: ResolvedScenario,
  assumptions: OwnerProfitAssumptions,
): OwnerProfitModels {
  const applications = (
    resolved.evaluation as PricingEvaluation & {
      policyApplications?: PolicyApplication[];
    }
  ).policyApplications;
  const rules = new Map(
    applications?.map((application) => [application.lineId, application.rules]),
  );
  if (
    !applications ||
    applications.length !== resolved.input.lines.length ||
    rules.size !== applications.length ||
    resolved.input.lines.some((line) => !rules.has(line.id))
  )
    throw new PricingError("pricing_policy_context_missing", 503);

  const selectedId =
    assumptions.selectedLineId ??
    (resolved.input.lines.length === 1
      ? resolved.input.lines[0].id
      : undefined);
  const selectedRule = selectedId ? rules.get(selectedId) : undefined;
  const input = selectedRule
    ? {
        ...resolved.input,
        policy: {
          ...resolved.input.policy,
          priceIncrementCents: selectedRule.priceIncrementCents,
          priceEndingCents: selectedRule.priceEndingCents,
          priceCeilingCents: selectedRule.priceCeilingCents,
        },
      }
    : resolved.input;
  const models = analyzeOwnerProfitModels(input, assumptions);

  const ceilingIssues = (evaluation: PricingEvaluation): PricingIssue[] =>
    evaluation.lines.flatMap((line) => {
      const ceiling = rules.get(line.id)?.priceCeilingCents;
      return ceiling !== undefined &&
        BigInt(line.extendedPriceCents) >
          BigInt(ceiling) * BigInt(line.quantity)
        ? [
            {
              code: "price_ceiling_exceeded",
              path: `lines.${line.id}`,
              message: `${line.sku} exceeds its resolved unit-price ceiling.`,
            },
          ]
        : [];
    });
  const constrain = <
    T extends OwnerModelResult & { evaluation: PricingEvaluation | null },
  >(
    item: T,
  ): T => {
    if (!item.evaluation) return item;
    const issues = ceilingIssues(item.evaluation);
    const revenue = resolved.scenario.revenue;
    if (
      revenue.mode === "insurance" &&
      revenue.allowedCents !== undefined &&
      item.evaluation.originalRevenueCents !== null &&
      item.evaluation.originalRevenueCents > revenue.allowedCents
    )
      issues.push({
        code: "collectible_exceeds_allowed",
        path: "revenue.expectedCollectibleCents",
        message:
          "Projected insurance collections exceed the resolved allowed amount.",
      });
    if (!issues.length) return item;
    return {
      ...item,
      status: "blocked",
      issues: combineIssues(item.issues, issues),
      evaluation: {
        ...item.evaluation,
        state: "blocked",
        issues: combineIssues(item.evaluation.issues, issues),
      },
    };
  };
  const baselineIssues = ceilingIssues(resolved.evaluation);
  const unchangedPriceModel = <T extends OwnerModelResult>(model: T): T => {
    if (!baselineIssues.length) return model;
    return {
      ...model,
      status:
        model.status === "calculated" || model.status === "estimated"
          ? "blocked"
          : model.status,
      issues: combineIssues(model.issues, baselineIssues),
    };
  };
  return {
    ...models,
    baseline: baselineIssues.length
      ? {
          ...resolved.evaluation,
          state: "blocked",
          issues: combineIssues(resolved.evaluation.issues, baselineIssues),
        }
      : resolved.evaluation,
    strategies: regroup(
      models.strategies.items.map((item) => {
        const constrained = constrain(item);
        // Keep explicit reference-price what-ifs visible for diagnosis. An invalid
        // automatically recommended amount must never be presented as usable.
        return constrained !== item && item.strategy !== "reference_price"
          ? {
              ...constrained,
              unitPriceCents: null,
              recommendationStatus: "no_qualifying_price" as const,
            }
          : constrained;
      }),
    ),
    sensitivity: models.sensitivity.items.length
      ? regroup(models.sensitivity.items.map(constrain))
      : models.sensitivity,
    priceVolume: models.priceVolume.items.length
      ? regroup(models.priceVolume.items.map(constrain))
      : models.priceVolume,
    monthly: unchangedPriceModel(models.monthly),
    acquisition: unchangedPriceModel(models.acquisition),
  };
}
