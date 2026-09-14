import {
  evaluatePricing,
  PricingValidationError,
  type PricingInput,
} from "@workspace/resupply-domain";
import type { Database, OrgScopedClient } from "@workspace/resupply-db";
import type {
  PortfolioItem,
  PriceBatch,
  PriceComparison,
  ResolvedScenario,
  Scenario,
} from "./contracts";
import {
  getActivePrices,
  approvalClass,
  getPricingState,
  listCurrentOffers,
  offerDto,
  PricingError,
  resolveScenario,
} from "./service";

export async function listPricingPortfolio(
  scoped: OrgScopedClient,
  options: {
    q?: string;
    category?: string;
    supplier?: string;
    offset: number;
    limit: number;
  },
): Promise<{ items: PortfolioItem[]; hasMore: boolean }> {
  const active = await getActivePrices(scoped, undefined, true);
  const activeOfferIds = [
    ...new Set(
      active?.entries.flatMap((entry) =>
        entry.scenario.lines.map((line) => line.offerId),
      ) ?? [],
    ),
  ];
  const result = await scoped
    .raw()
    .schema("resupply")
    .rpc("pricing_portfolio", {
      p_org_id: scoped.orgId,
      p_q: options.q,
      p_category: options.category,
      p_supplier: options.supplier,
      p_offset: options.offset,
      p_limit: options.limit + 1,
      p_active_offer_ids: activeOfferIds,
    });
  if (result.error) throw new PricingError("pricing_unavailable", 503);
  const rows = result.data ?? [];
  return {
    hasMore: rows.length > options.limit,
    items: rows
      .slice(0, options.limit)
      .map(
        (
          row: Database["resupply"]["Functions"]["pricing_portfolio"]["Returns"][number],
        ) => ({
          sku: row.sku,
          name: row.name,
          category: row.category,
          offers: (
            row.offers as unknown as Database["resupply"]["Tables"]["pricing_offers"]["Row"][]
          )
            .slice(0, 100)
            .map(offerDto),
          hasMoreOffers: row.has_more_offers,
          activeEntries:
            active?.entries.flatMap((entry, entryIndex) =>
              entry.scenario.lines.some(
                (line) =>
                  line.sku === row.sku &&
                  (!options.supplier ||
                    row.matching_offer_ids.includes(line.offerId)),
              )
                ? [
                    {
                      batchId: active.id,
                      entryIndex,
                      entry,
                      suppliers: (
                        row.active_suppliers as unknown as PortfolioItem["activeEntries"][number]["suppliers"]
                      ).filter((supplier) =>
                        entry.scenario.lines.some(
                          (line) =>
                            line.sku === row.sku &&
                            line.offerId === supplier.offerId,
                        ),
                      ),
                    },
                  ]
                : [],
            ) ?? [],
        }),
      ),
  };
}

/** Explicitly refresh a catalog scenario, never its manual verification evidence. */
export async function refreshPortfolioScenario(
  scoped: OrgScopedClient,
  scenario: Scenario,
  now = new Date(),
): Promise<ResolvedScenario> {
  if (scenario.patientId)
    throw new PricingError("catalog_batch_cannot_link_patient");
  const [offers, state] = await Promise.all([
    listCurrentOffers(scoped, {
      ids: [...new Set(scenario.lines.map((line) => line.offerId))],
      limit: 101,
    }),
    getPricingState(scoped),
  ]);
  const versions = new Map(offers.map((offer) => [offer.id, offer]));
  const limits = [now.getTime() + 30 * 60_000];
  const evidenceExpiry = (expiry?: string | null) => {
    if (!expiry) return;
    const instant = Date.parse(expiry);
    if (!Number.isFinite(instant) || instant <= now.getTime())
      throw new PricingError("stale_dependencies");
    limits.push(instant);
  };
  evidenceExpiry(state.policy?.expiresAt);
  for (const override of state.policy?.overrides ?? []) {
    // Do not cross a rule boundary within a refreshed review's validity.
    for (const value of [override.effectiveFrom, override.expiresAt]) {
      const instant = Date.parse(value);
      if (instant > now.getTime()) limits.push(instant);
    }
  }
  const lines = scenario.lines.map((line) => {
    const offer = versions.get(line.offerId);
    if (!offer || offer.sku !== line.sku)
      throw new PricingError("stale_dependencies");
    evidenceExpiry(offer.expiresAt);
    offer.components.forEach((cost) => evidenceExpiry(cost.expiresAt));
    return { ...line, offerVersion: offer.version };
  });
  scenario.costs?.forEach((cost) => evidenceExpiry(cost.expiresAt));
  if (scenario.revenue.mode === "insurance")
    evidenceExpiry(scenario.revenue.expiresAt);
  evidenceExpiry(scenario.processing?.expiresAt);
  evidenceExpiry(scenario.adjustments?.expiresAt);
  return resolveScenario(
    scoped,
    {
      ...scenario,
      policyId: undefined,
      activePriceListId: undefined,
      lines,
      validUntil: new Date(Math.min(...limits)).toISOString(),
    },
    { mayVerify: true, now },
  );
}

function lineKey(lines: Scenario["lines"]) {
  return lines
    .map((line) => `${line.sku}:${line.quantity}`)
    .sort()
    .join("|");
}
function contextKey(scenario: Scenario) {
  return `${scenario.revenue.mode}:${lineKey(scenario.lines)}`;
}
export class PortfolioReviewError extends PricingError {
  constructor(
    code: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(code);
  }
}
/** A selected change always previews the complete future price list. */
export async function preparePortfolioBatch(
  scoped: OrgScopedClient,
  scenarios: Scenario[],
  mayVerify: boolean,
) {
  const previous = await getActivePrices(scoped, undefined, true);
  const previousKeys =
    previous?.entries.map((entry) => contextKey(entry.scenario)) ?? [];
  if (new Set(previousKeys).size !== previousKeys.length)
    throw new PricingError("ambiguous_published_price");
  const selectedKeys = new Set<string>();
  for (const scenario of scenarios) {
    if (scenario.patientId)
      throw new PricingError("catalog_batch_cannot_link_patient");
    const key = contextKey(scenario);
    if (selectedKeys.has(key))
      throw new PricingError("duplicate_price_context");
    selectedKeys.add(key);
  }
  const retained =
    previous?.entries.filter(
      (entry) => !selectedKeys.has(contextKey(entry.scenario)),
    ) ?? [];
  if (scenarios.length + retained.length > 100)
    throw new PricingError("price_list_context_limit");
  const entries: Array<
    ResolvedScenario & {
      approvalClass: ReturnType<typeof approvalClass>;
      changeKind: "selected" | "retained";
      comparison: PriceComparison;
    }
  > = [];
  for (const scenario of scenarios) {
    const resolved = await resolveScenario(scoped, scenario, { mayVerify });
    entries.push({
      ...resolved,
      approvalClass: approvalClass(resolved),
      changeKind: "selected",
      comparison: comparePublishedPrices(resolved, previous),
    });
  }
  const failures: Array<{ path: string; message: string }> = [];
  for (const entry of retained) {
    try {
      const resolved = await refreshPortfolioScenario(scoped, entry.scenario);
      if (approvalClass(resolved) !== "firm")
        throw new PricingError("retained_price_no_longer_meets_policy");
      entries.push({
        ...resolved,
        approvalClass: "firm",
        changeKind: "retained",
        comparison: comparePublishedPrices(resolved, previous),
      });
    } catch (error) {
      if (
        !(
          error instanceof PricingError ||
          error instanceof PricingValidationError
        )
      )
        throw error;
      failures.push({
        path: contextKey(entry.scenario),
        message:
          error instanceof PricingError ? error.code : "invalid_pricing_input",
      });
    }
  }
  if (failures.length)
    throw new PortfolioReviewError(
      "retained_context_requires_review",
      failures,
    );
  return { entries, expectedActivePriceListId: previous?.id ?? null };
}

/** Previous published amounts evaluated under the SAME current proposed inputs.
 * No historical costs, supplier terms, collectible revenue or manual evidence are reused.
 */
export function comparePublishedPrices(
  resolved: ResolvedScenario,
  batch: PriceBatch | null,
): PriceComparison {
  const result: PriceComparison = {
    status: "no_published_price",
    reason: null,
    evaluatedAt: resolved.input.evaluatedAt,
    previousPriceListId: batch?.id ?? null,
    previousEntryIndexes: [],
    previousUnitAmounts: [],
    previousInput: null,
    previousEvaluation: null,
  };
  if (!batch) return result;
  const sameMode = batch.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.scenario.revenue.mode === resolved.scenario.revenue.mode,
    );
  const exact = sameMode.filter(
    ({ entry }) =>
      lineKey(entry.scenario.lines) === lineKey(resolved.scenario.lines),
  );
  const sources = exact.length
    ? exact
    : sameMode.filter(({ entry }) => entry.scenario.lines.length === 1);
  for (const line of resolved.scenario.lines) {
    const matches = sources.flatMap(({ entry, index }) =>
      entry.scenario.lines
        .filter(
          (previous) =>
            previous.sku === line.sku && previous.quantity === line.quantity,
        )
        .map((previous) => ({ index, amount: previous.unitAmountCents })),
    );
    if (!matches.length) return result;
    if (new Set(matches.map((match) => match.amount)).size !== 1)
      return { ...result, status: "ambiguous_published_price" };
    result.previousEntryIndexes.push(...matches.map((match) => match.index));
    result.previousUnitAmounts.push({
      sku: line.sku,
      quantity: line.quantity,
      unitAmountCents: matches[0].amount,
    });
  }
  result.previousEntryIndexes = [...new Set(result.previousEntryIndexes)].sort(
    (a, b) => a - b,
  );
  const prices = new Map(
    result.previousUnitAmounts.map((line) => [line.sku, line.unitAmountCents]),
  );
  const previousInput: PricingInput = {
    ...resolved.input,
    lines: resolved.input.lines.map((line) => ({
      ...line,
      unitPriceCents: prices.get(line.sku)!,
    })),
  };
  try {
    return {
      ...result,
      status: "comparable",
      previousInput,
      previousEvaluation: evaluatePricing(previousInput),
    };
  } catch (error) {
    if (!(error instanceof PricingValidationError)) throw error;
    return {
      ...result,
      status: "comparison_unavailable",
      reason: "previous_amounts_incompatible_with_current_assumptions",
      previousInput,
    };
  }
}
