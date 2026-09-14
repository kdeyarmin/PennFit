import { createHash } from "node:crypto";
import {
  evaluatePricing,
  compareProposedSupplierCosts,
  PricingValidationError,
  recommendPricing,
  type PricingCostComponent,
  type PricingInput,
} from "@workspace/resupply-domain";
import type { Database, Json, OrgScopedClient } from "@workspace/resupply-db";
import type {
  ActualEvent,
  OfferVersion,
  PolicyVersion,
  PriceBatch,
  PricingForecast,
  PricingState,
  Proposal,
  Quote,
  Reconciliation,
  ResolvedScenario,
  RevenueProfile,
  Scenario,
} from "./contracts";
import {
  pricingDestinationFingerprint,
  pricingShippingAddress,
} from "./shipping";

type Row<T extends keyof Database["resupply"]["Tables"]> =
  Database["resupply"]["Tables"][T]["Row"];
export class PricingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 422,
  ) {
    super(code);
    this.name = "PricingError";
  }
}
function dbError(error: { message?: string; code?: string } | null) {
  if (!error) return;
  const known = [
    "revision_conflict",
    "stale_dependencies",
    "blocked_pricing",
    "not_found",
    "order_required",
    "duplicate_economic_event",
    "invalid_line",
    "invalid_sku",
    "invalid_body",
    "price_list_contexts_changed",
    "schedule_exists",
  ];
  const code = known.find((name) => error.message?.includes(name));
  throw new PricingError(
    code ?? "pricing_unavailable",
    code === "not_found"
      ? 404
      : error.code === "40001" ||
          error.code === "PT409" ||
          code === "price_list_contexts_changed"
        ? 409
        : code
          ? 422
          : 503,
  );
}
export function offerDto(row: Row<"pricing_offers">): OfferVersion {
  return {
    ...(row.data as unknown as OfferVersion),
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
export function policyDto(row: Row<"pricing_policies">): PolicyVersion {
  return {
    ...(row.data as unknown as PolicyVersion),
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
export function quoteDto(row: Row<"pricing_quotes">): Quote {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    patientId: row.patient_id,
    lines: row.lines as unknown as Quote["lines"],
    validUntil: row.valid_until,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    scenario: row.scenario as unknown as Scenario,
    input: row.input as unknown as PricingInput,
    evaluation: row.evaluation as unknown as Quote["evaluation"],
    dependencies: row.dependencies as unknown as Quote["dependencies"],
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    boundOrderId: row.bound_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function proposalDto(
  row: Row<"pricing_proposals">,
  now = new Date(),
): Proposal {
  const data = row.data as unknown as Proposal;
  return {
    ...data,
    ...(data.comparison
      ? {
          comparisonResult: compareProposedSupplierCosts(
            data.comparison,
            now.toISOString(),
          ),
        }
      : {}),
    id: row.id,
    revision: row.revision,
    status: row.status,
    sku: row.sku,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
  };
}
export function batchDto(
  row: Row<"pricing_price_lists">,
  activeId: string | null,
): PriceBatch {
  return {
    id: row.id,
    name: row.name,
    entries: row.entries as unknown as ResolvedScenario[],
    selectedEntryCount: (
      row.entries as unknown as PriceBatch["entries"]
    ).filter((entry) => entry.changeKind !== "retained").length,
    retainedEntryCount: (
      row.entries as unknown as PriceBatch["entries"]
    ).filter((entry) => entry.changeKind === "retained").length,
    createdAt: row.created_at,
    active: row.id === activeId,
    scheduledAt: row.scheduled_at,
    scheduleStatus: row.schedule_status,
    scheduleError: row.schedule_error,
  };
}
export function revenueProfileDto(
  row: Row<"pricing_revenue_profiles">,
): RevenueProfile {
  return {
    ...(row.data as unknown as RevenueProfile),
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
  };
}
export async function mutatePricing(
  scoped: OrgScopedClient,
  actor: string,
  operation: string,
  payload: unknown,
) {
  const serialized = JSON.parse(JSON.stringify(payload)) as Json;
  const { data, error } =
    operation === "portfolio_batch"
      ? await scoped
          .raw()
          .schema("resupply")
          .rpc("pricing_save_portfolio_batch", {
            p_org_id: scoped.orgId,
            p_actor: actor,
            p_expected_active_price_list_id: (
              payload as { expectedActivePriceListId: string | null }
            ).expectedActivePriceListId,
            p_payload: serialized,
          })
      : await scoped.raw().schema("resupply").rpc("pricing_mutate", {
          p_org_id: scoped.orgId,
          p_actor: actor,
          p_operation: operation,
          p_payload: serialized,
        });
  dbError(error);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new PricingError("pricing_unavailable", 503);
  return data;
}
export async function getPricingState(
  scoped: OrgScopedClient,
): Promise<PricingState> {
  const scheduled = await scoped
    .raw()
    .schema("resupply")
    .rpc("pricing_apply_scheduled", { p_org_id: scoped.orgId });
  dbError(scheduled.error);
  const { data, error } = await scoped
    .from("pricing_state")
    .select("*")
    .maybeSingle();
  dbError(error);
  if (!data)
    return {
      revision: 0,
      enabled: false,
      enforceQuotes: false,
      policy: null,
      activePriceListId: null,
    };
  let policy: PolicyVersion | null = null;
  if (data.current_policy_id) {
    const response = await scoped
      .from("pricing_policies")
      .select("*")
      .eq("id", data.current_policy_id)
      .maybeSingle();
    dbError(response.error);
    if (!response.data) throw new PricingError("pricing_unavailable", 503);
    policy = policyDto(response.data);
  }
  return {
    revision: data.revision,
    enabled: data.enabled,
    enforceQuotes: data.enforce_quotes,
    policy,
    activePriceListId: data.active_price_list_id,
  };
}
export async function getActivePrices(
  scoped: OrgScopedClient,
  state?: PricingState,
  includePaused = false,
): Promise<PriceBatch | null> {
  const current = state ?? (await getPricingState(scoped));
  if ((!current.enabled && !includePaused) || !current.activePriceListId)
    return null;
  const { data, error } = await scoped
    .from("pricing_price_lists")
    .select("*")
    .eq("id", current.activePriceListId)
    .maybeSingle();
  dbError(error);
  if (!data) throw new PricingError("pricing_unavailable", 503);
  return batchDto(data, current.activePriceListId);
}
export async function listCurrentOffers(
  scoped: OrgScopedClient,
  options: {
    ids?: string[];
    sku?: string;
    offset?: number;
    limit?: number;
  } = {},
): Promise<OfferVersion[]> {
  const { data, error } = await scoped
    .raw()
    .schema("resupply")
    .rpc("pricing_current_offers", {
      p_org_id: scoped.orgId,
      p_ids: options.ids,
      p_sku: options.sku,
      p_offset: options.offset,
      p_limit: options.limit,
    });
  dbError(error);
  return (data ?? []).map(offerDto);
}
function selectedLineRules(
  policy: PolicyVersion,
  scenario: Scenario,
  categories: Map<string, string>,
  now: Date,
): PolicyVersion["rules"][] {
  const rank = { revenue_mode: 1, category: 2, sku: 3 };
  return scenario.lines.map((line) => {
    const matching = (policy.overrides ?? [])
      .filter((override) => {
        const matches =
          override.value ===
          (override.scope === "sku"
            ? line.sku
            : override.scope === "category"
              ? categories.get(line.sku)
              : scenario.revenue.mode);
        if (
          matches &&
          Date.parse(override.effectiveFrom) > now.getTime() &&
          Date.parse(override.effectiveFrom) < Date.parse(scenario.validUntil)
        )
          throw new PricingError("quote_crosses_policy_change");
        return (
          matches &&
          Date.parse(override.effectiveFrom) <= now.getTime() &&
          Date.parse(override.expiresAt) > now.getTime()
        );
      })
      .sort((a, b) => rank[b.scope] - rank[a.scope] || b.priority - a.priority);
    const selected = matching[0];
    if (
      selected &&
      Date.parse(selected.expiresAt) < Date.parse(scenario.validUntil)
    )
      throw new PricingError("quote_exceeds_source_expiry");
    return selected?.rules ?? policy.rules;
  });
}
export function resolvedPolicyRules(
  policy: PolicyVersion,
  scenario: Scenario,
  categories: Map<string, string>,
  now: Date,
): PolicyVersion["rules"] {
  const selected = selectedLineRules(policy, scenario, categories, now);
  const ceilings = selected.flatMap((rule) =>
    rule.priceCeilingCents === undefined ? [] : [rule.priceCeilingCents],
  );
  return {
    ...selected[0],
    targetMarginBps: Math.max(...selected.map((rule) => rule.targetMarginBps)),
    floorMarginBps: Math.max(...selected.map((rule) => rule.floorMarginBps)),
    minimumContributionCents: Math.max(
      ...selected.map((rule) => rule.minimumContributionCents ?? 0),
    ),
    lineFloorMarginBps: selected.some(
      (rule) => rule.lineFloorMarginBps !== undefined,
    )
      ? Math.max(...selected.map((rule) => rule.lineFloorMarginBps ?? 0))
      : undefined,
    priceCeilingCents: selected.length === 1 ? ceilings[0] : undefined,
    basis: selected.some((rule) => rule.basis === "after_overhead")
      ? "after_overhead"
      : "contribution",
  };
}
export function assertPublishedAmounts(
  scenario: Scenario,
  batch: PriceBatch | null,
): void {
  if (!batch) return;
  const matchingMode = batch.entries.filter(
    (entry) => entry.scenario.revenue.mode === scenario.revenue.mode,
  );
  const exact = matchingMode.filter((entry) =>
    sameLines(entry.scenario.lines, scenario.lines),
  );
  const sources = exact.length
    ? exact
    : scenario.lines.flatMap((line) =>
        matchingMode.filter(
          (entry) =>
            entry.scenario.lines.length === 1 &&
            entry.scenario.lines[0].sku === line.sku &&
            entry.scenario.lines[0].quantity === line.quantity,
        ),
      );
  for (const line of scenario.lines) {
    const prices = sources.flatMap((entry) =>
      entry.scenario.lines
        .filter(
          (item) => item.sku === line.sku && item.quantity === line.quantity,
        )
        .map((item) => item.unitAmountCents),
    );
    if (new Set(prices).size > 1)
      throw new PricingError("ambiguous_published_price");
    if (
      !prices.length &&
      matchingMode.some((entry) =>
        entry.scenario.lines.some((item) => item.sku === line.sku),
      )
    )
      throw new PricingError("published_price_context_required");
    if (prices.length && line.unitAmountCents !== prices[0])
      throw new PricingError("active_price_mismatch");
  }
}
export async function getQuote(
  scoped: OrgScopedClient,
  id: string,
): Promise<Row<"pricing_quotes">> {
  const { data, error } = await scoped
    .from("pricing_quotes")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  dbError(error);
  if (!data) throw new PricingError("not_found", 404);
  return data;
}
function namespace(supplier: string) {
  return createHash("sha256")
    .update(supplier.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);
}
function sameLines(
  a: Array<{ sku: string; quantity: number }>,
  b: Array<{ sku: string; quantity: number }>,
) {
  const key = (lines: typeof a) =>
    lines
      .map((line) => `${line.sku}:${line.quantity}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}
/** Resolves all financial authority on the server; browser verification flags are advisory. */
export async function resolveScenario(
  scoped: OrgScopedClient,
  scenario: Scenario,
  options: {
    mayVerify: boolean;
    now?: Date;
    enforceActivePrices?: boolean;
    /** Internal signed-order delivery review only; its SQL check preserves accepted prices. */
    preserveAcceptedUnitAmounts?: boolean;
  },
): Promise<ResolvedScenario> {
  const now = options.now ?? new Date();
  const { deliveryAddressSnapshot: _submittedSnapshot, ...submitted } =
    scenario;
  void _submittedSnapshot;
  scenario = submitted;
  if (
    Date.parse(scenario.validUntil) <= now.getTime() ||
    Date.parse(scenario.validUntil) > now.getTime() + 30 * 86_400_000
  )
    throw new PricingError("invalid_quote_expiry");
  const state = await getPricingState(scoped);
  if (options.enforceActivePrices)
    assertPublishedAmounts(scenario, await getActivePrices(scoped, state));
  scenario = { ...scenario, activePriceListId: state.activePriceListId };
  let policy = state.policy;
  if (scenario.policyId && scenario.policyId !== policy?.id) {
    const response = await scoped
      .from("pricing_policies")
      .select("*")
      .eq("id", scenario.policyId)
      .maybeSingle();
    dbError(response.error);
    policy = response.data ? policyDto(response.data) : null;
  }
  if (!policy) throw new PricingError("policy_required");
  if (
    Date.parse(policy.effectiveFrom) > now.getTime() ||
    Date.parse(policy.expiresAt) <= now.getTime()
  )
    throw new PricingError("stale_policy", 409);
  if (Date.parse(scenario.validUntil) > Date.parse(policy.expiresAt))
    throw new PricingError("quote_exceeds_source_expiry");
  let patientAddress: Json | null = null;
  if (scenario.patientId) {
    const response = await scoped
      .from("patients")
      .select("id,address")
      .eq("id", scenario.patientId)
      .maybeSingle();
    dbError(response.error);
    if (!response.data) throw new PricingError("not_found", 404);
    patientAddress = response.data.address;
  }
  const catalog = await scoped
    .from("products")
    .select("sku,category")
    .in(
      "sku",
      scenario.lines.map((line) => line.sku),
    )
    .eq("active", true);
  dbError(catalog.error);
  const catalogSkus = new Set(
    (catalog.data ?? []).map((row: { sku: string }) => row.sku),
  );
  if (scenario.lines.some((line) => !catalogSkus.has(line.sku)))
    throw new PricingError("unresolved_sku");
  const offers = new Map<string, OfferVersion>(
    (
      await listCurrentOffers(scoped, {
        ids: scenario.lines.map((line) => line.offerId),
      })
    ).map((offer) => [offer.id, offer]),
  );
  const dependencies: ResolvedScenario["dependencies"] = [];
  const costs = new Map<string, PricingCostComponent>();
  const lines: PricingInput["lines"][number][] = [];
  const freightRequired = new Map<string, string>();
  const freightCovered = new Set<string>();
  const address = pricingShippingAddress(patientAddress);
  const destination = scenario.patientId
    ? {
        country: address?.country ?? "US",
        postalCode: address?.zip ?? "",
        service: scenario.delivery?.service ?? "",
      }
    : scenario.delivery;
  for (const line of scenario.lines) {
    const offer = offers.get(line.offerId);
    if (!offer || offer.version !== line.offerVersion || offer.sku !== line.sku)
      throw new PricingError("stale_dependencies", 409);
    if (
      offer.availability === "unavailable" ||
      offer.availability === "backorder"
    )
      throw new PricingError("supplier_unavailable");
    if (Date.parse(offer.effectiveFrom) > now.getTime())
      throw new PricingError("offer_not_effective");
    if (
      line.quantity < offer.minQuantity ||
      (offer.maxQuantity !== null && line.quantity > offer.maxQuantity)
    )
      throw new PricingError("quantity_outside_offer");
    // unitCostCents is per canonical sell unit; requiring whole verified supplier packs avoids quietly buying surplus units for free.
    if (line.quantity % offer.unitsPerPack !== 0)
      throw new PricingError("pack_quantity_mismatch");
    if (Date.parse(scenario.validUntil) > Date.parse(offer.expiresAt))
      throw new PricingError("quote_exceeds_source_expiry");
    dependencies.push({
      offerId: offer.id,
      version: offer.version,
      expiresAt: offer.expiresAt,
    });
    const hasFreight = offer.components.some(
      (component) => component.category === "freight",
    );
    const scope = offer.deliveryScope;
    if (
      hasFreight &&
      scope &&
      destination?.service &&
      (scope.country.toUpperCase() !== destination.country.toUpperCase() ||
        scope.service !== destination.service ||
        !scope.fulfillmentMethods.includes(line.fulfillmentMethod) ||
        !scope.postalPrefixes.some(
          (prefix) =>
            prefix === "*" || destination.postalCode?.startsWith(prefix),
        ))
    )
      throw new PricingError("offer_outside_delivery_scope");
    const scopeUnverified =
      hasFreight &&
      (!scope || !destination?.service || !destination.postalCode);
    const costStatus =
      offer.status === "verified" &&
      (scopeUnverified ||
        !["available", "limited"].includes(offer.availability ?? "unknown"))
        ? "estimated"
        : offer.status;
    lines.push({
      id: line.id,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unitAmountCents,
      unitCostCents: offer.unitCostCents,
      costStatus,
      costExpiresAt: offer.expiresAt,
      taxBps: line.taxBps,
    });
    const prefix = namespace(offer.supplierName);
    if (!offer.components.some((component) => component.category === "freight"))
      freightRequired.set(prefix, offer.supplierName);
    else freightCovered.add(prefix);
    for (const component of offer.components) {
      const perUnit = component.basis === "unit";
      const id = `${prefix}:${perUnit ? `${line.id}:` : ""}${component.id}`;
      const includedInId =
        component.includedInId === "goods"
          ? line.id
          : component.includedInId
            ? `${prefix}:${perUnit ? `${line.id}:` : ""}${component.includedInId}`
            : undefined;
      const resolved: PricingCostComponent = {
        ...component,
        id,
        quantity: perUnit
          ? line.quantity * component.quantity
          : component.quantity,
        includedInId,
        expiresAt: component.expiresAt ?? offer.expiresAt,
      };
      const previous = costs.get(id);
      if (previous) {
        const withoutExpiry = (cost: PricingCostComponent) => ({
          ...cost,
          expiresAt: undefined,
        });
        if (
          JSON.stringify(withoutExpiry(previous)) !==
          JSON.stringify(withoutExpiry(resolved))
        )
          throw new PricingError("conflicting_supplier_fee");
        if (
          previous.expiresAt &&
          resolved.expiresAt &&
          Date.parse(previous.expiresAt) < Date.parse(resolved.expiresAt)
        )
          resolved.expiresAt = previous.expiresAt;
      }
      costs.set(id, resolved);
    }
    if (
      line.fulfillmentMethod === "dropship" &&
      !offer.components.some((component) => component.category === "dropship")
    )
      costs.set(`missing-dropship:${line.id}`, {
        id: `missing-dropship:${line.id}`,
        label: "Supplier drop-ship fee requires verification (including zero)",
        category: "dropship",
        basis: "order",
        amountCents: null,
        status: "missing",
      });
  }
  for (const supplier of freightCovered) freightRequired.delete(supplier);
  if (scenario.shippingQuoteId) {
    const shipping = await scoped
      .from("pricing_shipping_quotes")
      .select("*")
      .eq("id", scenario.shippingQuoteId)
      .maybeSingle();
    dbError(shipping.error);
    const row = shipping.data as Row<"pricing_shipping_quotes"> | null;
    const data = row?.data as
      | {
          patientId?: string;
          lines?: Array<{ sku: string; quantity: number }>;
          patientAddressSnapshot?: Json;
          destinationFingerprint?: string;
        }
      | undefined;
    if (
      !row ||
      !data?.lines ||
      !scenario.patientId ||
      data.patientId !== scenario.patientId ||
      scenario.lines.some((line) => line.fulfillmentMethod !== "stock") ||
      !sameLines(data.lines, scenario.lines) ||
      data.destinationFingerprint !==
        pricingDestinationFingerprint(patientAddress)
    )
      throw new PricingError("shipping_quote_mismatch");
    if (Date.parse(row.expires_at) < Date.parse(scenario.validUntil))
      throw new PricingError("quote_exceeds_source_expiry");
    costs.set(`shipping:${row.id}`, {
      id: `shipping:${row.id}`,
      label: "Verified carrier quote",
      category: "freight",
      basis: "shipment",
      amountCents: row.cost_cents,
      quantity: 1,
      status: "verified",
      expiresAt: row.expires_at,
    });
    if (
      [...costs.values()].some(
        (cost) =>
          cost.id !== `shipping:${row.id}` &&
          cost.category === "freight" &&
          (cost.amountCents ?? 0) > 0 &&
          !cost.includedInId,
      )
    )
      throw new PricingError("duplicate_shipping_cost");
    freightRequired.clear();
  }
  for (const component of scenario.costs ?? []) {
    const id = `manual:${component.id}`;
    if (costs.has(id)) throw new PricingError("duplicate_cost_component");
    costs.set(id, {
      ...component,
      id,
      includedInId: component.includedInId
        ? `manual:${component.includedInId}`
        : undefined,
      status:
        component.amountCents === null
          ? "missing"
          : options.mayVerify &&
              (component.category !== "freight" ||
                Boolean(destination?.service && destination.postalCode))
            ? component.status
            : "estimated",
    });
  }
  // A manual whole-order freight estimate can cover a single supplier/warehouse.
  // Multi-supplier delivery requires a separate verified fee on each supplier offer.
  if (
    freightRequired.size === 1 &&
    new Set([...offers.values()].map((offer) => namespace(offer.supplierName)))
      .size === 1 &&
    (scenario.costs ?? []).some((cost) => cost.category === "freight")
  )
    freightRequired.clear();
  for (const [key, supplier] of freightRequired)
    costs.set(`missing-freight:${key}`, {
      id: `missing-freight:${key}`,
      label: `Freight requires verification: ${supplier}`.slice(0, 160),
      category: "freight",
      basis: "shipment",
      amountCents: null,
      status: "missing",
    });
  for (const cost of costs.values())
    if (
      cost.expiresAt &&
      Date.parse(cost.expiresAt) < Date.parse(scenario.validUntil)
    )
      throw new PricingError("quote_exceeds_source_expiry");
  if (
    scenario.revenue.mode === "insurance" &&
    scenario.revenue.expiresAt &&
    Date.parse(scenario.revenue.expiresAt) < Date.parse(scenario.validUntil)
  )
    throw new PricingError("quote_exceeds_source_expiry");
  let revenue =
    scenario.revenue.mode === "insurance"
      ? {
          ...scenario.revenue,
          status:
            options.mayVerify &&
            scenario.revenue.source &&
            scenario.revenue.expiresAt
              ? scenario.revenue.status
              : scenario.revenue.expectedCollectibleCents === null
                ? ("missing" as const)
                : ("estimated" as const),
        }
      : scenario.revenue;
  if (scenario.revenueProfileId) {
    if (scenario.revenue.mode !== "insurance" || !scenario.patientId)
      throw new PricingError("revenue_profile_mismatch");
    const profileResult = await scoped
      .from("pricing_revenue_profiles")
      .select("*")
      .eq("id", scenario.revenueProfileId)
      .lte("effective_from", now.toISOString())
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    dbError(profileResult.error);
    const profile = profileResult.data
      ? revenueProfileDto(profileResult.data)
      : null;
    if (
      !profile ||
      profile.patientId !== scenario.patientId ||
      profile.version !== scenario.revenueProfileVersion ||
      !sameLines(profile.lines, scenario.lines)
    )
      throw new PricingError("revenue_profile_mismatch");
    if (Date.parse(profile.expiresAt) < Date.parse(scenario.validUntil))
      throw new PricingError("quote_exceeds_source_expiry");
    revenue = {
      mode: "insurance",
      expectedCollectibleCents: profile.expectedCollectibleCents,
      status: "verified",
      expiresAt: profile.expiresAt,
      source: profile.source,
      allowedCents: profile.allowedCents,
    };
    scenario = { ...scenario, revenue };
  }
  const rules = resolvedPolicyRules(
    policy,
    scenario,
    new Map(
      (catalog.data ?? []).map((row: { sku: string; category: string }) => [
        row.sku,
        row.category,
      ]),
    ),
    now,
  );
  const input: PricingInput = {
    currency: "USD",
    evaluatedAt: now.toISOString(),
    lines,
    costs: [...costs.values()],
    revenue,
    policy: rules,
    processing: scenario.processing
      ? {
          ...scenario.processing,
          status: options.mayVerify
            ? (scenario.processing.status ?? "verified")
            : "estimated",
        }
      : null,
    adjustments: scenario.adjustments
      ? {
          ...scenario.adjustments,
          status: options.mayVerify
            ? (scenario.adjustments.status ?? "verified")
            : "estimated",
        }
      : undefined,
  };
  for (const source of [input.processing, input.adjustments])
    if (
      source?.expiresAt &&
      Date.parse(source.expiresAt) < Date.parse(scenario.validUntil)
    )
      throw new PricingError("quote_exceeds_source_expiry");
  const appliedRules = selectedLineRules(
    policy,
    scenario,
    new Map(
      (catalog.data ?? []).map((row: { sku: string; category: string }) => [
        row.sku,
        row.category,
      ]),
    ),
    now,
  );
  const evaluation = {
    ...evaluatePricing(input),
    policyApplications: scenario.lines.map((line, index) => ({
      lineId: line.id,
      rules: appliedRules[index],
    })),
  };
  for (const [index, line] of scenario.lines.entries()) {
    const rule = appliedRules[index];
    if (
      !options.preserveAcceptedUnitAmounts &&
      rule.priceCeilingCents !== undefined &&
      line.unitAmountCents > rule.priceCeilingCents
    ) {
      evaluation.state = "blocked";
      evaluation.issues.push({
        code: "price_ceiling_exceeded",
        path: `lines.${line.id}`,
        message:
          "This item's billed unit amount exceeds its selected policy ceiling.",
      });
    }
  }
  scenario = {
    ...scenario,
    revenue,
    processing: input.processing
      ? {
          ...input.processing,
          expiresAt: input.processing.expiresAt ?? undefined,
          chargeAmountsCents: input.processing.chargeAmountsCents
            ? [...input.processing.chargeAmountsCents]
            : undefined,
        }
      : undefined,
    adjustments: input.adjustments
      ? {
          ...input.adjustments,
          expiresAt: input.adjustments.expiresAt ?? undefined,
        }
      : undefined,
    costs: scenario.costs?.map((cost) => ({
      ...cost,
      status: costs.get(`manual:${cost.id}`)!.status,
    })),
    ...(scenario.patientId ? { deliveryAddressSnapshot: patientAddress } : {}),
  };
  return {
    scenario,
    input,
    evaluation,
    dependencies,
    policyId: policy.id,
    policyVersion: policy.version,
  };
}
export function approvalClass(
  resolved: ResolvedScenario,
): "firm" | "exception" | "blocked" {
  if (
    resolved.evaluation.state === "blocked" ||
    !resolved.evaluation.calculationComplete ||
    resolved.evaluation.meetsFloor === false ||
    resolved.evaluation.meetsMinimumContribution === false ||
    resolved.evaluation.meetsLineFloors === false
  )
    return "blocked";
  if (
    resolved.evaluation.issues.some(
      (issue) => issue.code === "missing_input" || issue.code === "stale_input",
    )
  )
    return "blocked";
  return resolved.evaluation.state === "meets_target" ? "firm" : "exception";
}
export async function saveQuote(
  scoped: OrgScopedClient,
  actor: string,
  payload: {
    id?: string;
    expectedRevision?: number;
    scenario: Scenario;
    requestApproval: boolean;
  },
  mayVerify: boolean,
): Promise<Quote> {
  const resolved = await resolveScenario(scoped, payload.scenario, {
    mayVerify,
    enforceActivePrices: true,
  });
  const row = await mutatePricing(scoped, actor, "quote", {
    ...resolved,
    id: payload.id,
    expectedRevision: payload.expectedRevision,
    patientId: payload.scenario.patientId ?? null,
    validUntil: payload.scenario.validUntil,
    status: payload.requestApproval ? "pending_approval" : "draft",
    approvalClass: approvalClass(resolved),
    autoApprove: !payload.requestApproval && approvalClass(resolved) === "firm",
    lines: payload.scenario.lines.map((line, index) => ({
      ...line,
      unitCostCents: resolved.input.lines[index].unitCostCents,
    })),
  });
  return quoteDto(row as unknown as Row<"pricing_quotes">);
}
export async function prepareCsrPricing(
  scoped: OrgScopedClient,
  request: {
    quoteId: string;
    quoteRevision: number;
    patientId: string;
    items: Array<{
      id?: string;
      lineId?: string;
      sku?: string;
      description: string;
      quantity: number;
      unitAmountCents: number;
      fulfillmentMethod?: string;
    }>;
  },
): Promise<Quote> {
  let row = await getQuote(scoped, request.quoteId);
  if (row.revision !== request.quoteRevision)
    throw new PricingError("revision_conflict", 409);
  if (row.status !== "bound") {
    const { data, error } = await scoped
      .raw()
      .schema("resupply")
      .rpc("pricing_assert_quote_current", {
        p_org_id: scoped.orgId,
        p_quote_id: request.quoteId,
        p_revision: request.quoteRevision,
      });
    dbError(error);
    // Composite SQL return types are exposed as one-row arrays by PostgREST;
    // direct test/SQL adapters may return the object itself.
    const result = Array.isArray(data)
      ? data.length === 1
        ? data[0]
        : null
      : data;
    if (!result || typeof result !== "object" || !("id" in result))
      throw new PricingError("pricing_unavailable", 503);
    row = result as unknown as Row<"pricing_quotes">;
  }
  const quote = quoteDto(row);
  if (
    !["approved", "bound"].includes(quote.status) ||
    quote.patientId !== request.patientId ||
    quote.input.revenue.mode !== "insurance"
  )
    throw new PricingError("approved_insurance_quote_required");
  if (quote.lines.length !== request.items.length)
    throw new PricingError("quote_lines_mismatch");
  for (const line of quote.lines) {
    const item = request.items.find(
      (candidate) => (candidate.lineId ?? candidate.id) === line.id,
    );
    if (
      !item ||
      item.sku !== line.sku ||
      item.description !== line.description ||
      item.quantity !== line.quantity ||
      item.unitAmountCents !== line.unitAmountCents ||
      item.fulfillmentMethod !== line.fulfillmentMethod
    )
      throw new PricingError("quote_lines_mismatch");
  }
  return quote;
}
export async function getReconciliation(
  scoped: OrgScopedClient,
  quoteId: string,
): Promise<Reconciliation> {
  const response = await scoped
    .raw()
    .schema("resupply")
    .rpc("pricing_actuals_snapshot", {
      p_org_id: scoped.orgId,
      p_quote_id: quoteId,
    });
  dbError(response.error);
  const snapshot = response.data as unknown as {
    quote: Row<"pricing_quotes">;
    events: Row<"pricing_actual_events">[];
  };
  const row = snapshot.quote;
  if (snapshot.events.length > 1000)
    throw new PricingError("actuals_export_required");
  const events: ActualEvent[] = snapshot.events.map((event) => ({
    ...(event.data as unknown as ActualEvent),
    id: event.id,
    createdAt: event.created_at,
  }));
  const actualRevenueCents = events.reduce(
    (sum, event) =>
      sum +
      (event.kind === "revenue"
        ? event.amountCents
        : event.kind === "refund"
          ? -event.amountCents
          : 0),
    0,
  );
  const actualCostCents = events.reduce(
    (sum, event) =>
      sum +
      (event.kind === "cost"
        ? event.amountCents
        : event.kind === "cost_credit"
          ? -event.amountCents
          : 0),
    0,
  );
  const quote = quoteDto(row);
  const actualContributionCents = actualRevenueCents - actualCostCents;
  return {
    quote,
    events,
    revision: row.actuals_revision,
    costsComplete: row.costs_complete,
    revenueComplete: row.revenue_complete,
    settled: row.costs_complete && row.revenue_complete,
    actualRevenueCents,
    actualCostCents,
    actualContributionCents,
    actualMarginBps:
      actualRevenueCents > 0
        ? (actualContributionCents / actualRevenueCents) * 10000
        : null,
    quotedRevenueCents: quote.evaluation.netRevenueCents,
    quotedCostCents: quote.evaluation.totalVariableCostCents,
    costVarianceCents:
      quote.evaluation.totalVariableCostCents === null
        ? null
        : actualCostCents - quote.evaluation.totalVariableCostCents,
    revenueVarianceCents:
      quote.evaluation.netRevenueCents === null
        ? null
        : actualRevenueCents - quote.evaluation.netRevenueCents,
    forecast: await currentForecast(scoped, quote),
  };
}
export async function currentForecast(
  scoped: OrgScopedClient,
  quote: Quote,
): Promise<PricingForecast> {
  const now = new Date();
  try {
    const offers = new Map(
      (
        await listCurrentOffers(scoped, {
          ids: quote.scenario.lines.map((line) => line.offerId),
        })
      ).map((offer) => [offer.id, offer]),
    );
    let revenueProfileVersion = quote.scenario.revenueProfileVersion;
    if (quote.scenario.revenueProfileId) {
      const profile = await scoped
        .from("pricing_revenue_profiles")
        .select("version")
        .eq("id", quote.scenario.revenueProfileId)
        .lte("effective_from", now.toISOString())
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      dbError(profile.error);
      if (!profile.data) throw new PricingError("revenue_profile_mismatch");
      revenueProfileVersion = profile.data.version;
    }
    const scenario: Scenario = {
      ...quote.scenario,
      policyId: undefined,
      validUntil: new Date(now.getTime() + 30_000).toISOString(),
      revenueProfileVersion,
      lines: quote.scenario.lines.map((line) => ({
        ...line,
        offerVersion: offers.get(line.offerId)?.version ?? line.offerVersion,
      })),
    };
    const forecast = await resolveScenario(scoped, scenario, {
      mayVerify: true,
      now,
    });
    return {
      status: "available",
      evaluation: forecast.evaluation,
      reason: null,
      evaluatedAt: now.toISOString(),
    };
  } catch (error) {
    if (error instanceof PricingValidationError)
      return {
        status: "blocked",
        evaluation: null,
        reason: "invalid_pricing_input",
        evaluatedAt: now.toISOString(),
      };
    if (error instanceof PricingError)
      return {
        status: "blocked",
        evaluation: null,
        reason: error.code,
        evaluatedAt: now.toISOString(),
      };
    throw error;
  }
}
export function recommendResolved(resolved: ResolvedScenario, lineId?: string) {
  const selected =
    lineId ??
    (resolved.input.lines.length === 1
      ? resolved.input.lines[0].id
      : undefined);
  const applications =
    (
      resolved.evaluation as typeof resolved.evaluation & {
        policyApplications?: Array<{
          lineId: string;
          rules: PolicyVersion["rules"];
        }>;
      }
    ).policyApplications ?? [];
  const rule = applications.find((entry) => entry.lineId === selected)?.rules;
  if (
    applications.some(
      (entry) =>
        entry.lineId !== selected &&
        entry.rules.priceCeilingCents !== undefined &&
        (resolved.input.lines.find((line) => line.id === entry.lineId)
          ?.unitPriceCents ?? 0) > entry.rules.priceCeilingCents,
    )
  )
    return {
      status: "no_qualifying_price" as const,
      lineId: selected ?? null,
      recommendedUnitPriceCents: null,
      recommendedInput: null,
      evaluation: resolved.evaluation,
    };
  const input = rule
    ? {
        ...resolved.input,
        policy: {
          ...resolved.input.policy,
          priceIncrementCents: rule.priceIncrementCents,
          priceEndingCents: rule.priceEndingCents,
          priceCeilingCents: rule.priceCeilingCents,
        },
      }
    : resolved.input;
  return recommendPricing(input, lineId);
}
export { recommendPricing };
