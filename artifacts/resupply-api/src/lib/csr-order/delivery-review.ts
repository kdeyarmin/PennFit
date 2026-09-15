import { z } from "zod";
import type { Json, OrgScopedClient } from "@workspace/resupply-db";
import { validateReceiverAddress } from "@workspace/resupply-integrations-xps-ship";
import { pricingShippingAddress } from "../pricing/shipping";
import { scenarioSchema, type Scenario } from "../pricing/contracts";
import {
  approvalClass,
  getQuote,
  getPricingState,
  listCurrentOffers,
  PricingError,
  quoteDto,
  resolveScenario,
} from "../pricing/service";

const evidence = z
  .object({
    source: z.string().trim().min(3).max(1000),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const deliveryPreviewSchema = z
  .object({
    delivery: z
      .object({
        country: z.string().length(2),
        service: z.string().trim().min(1).max(100),
      })
      .strict(),
    shippingQuoteId: z.string().uuid().optional(),
    freight: evidence
      .extend({ amountCents: z.number().int().min(0).max(100_000_000) })
      .optional(),
    revenueVerification: evidence.optional(),
    costVerification: evidence.optional(),
  })
  .strict()
  .refine(
    (v) => !(v.shippingQuoteId && v.freight),
    "Use a carrier rate or a freight estimate, not both.",
  );
export const deliveryApprovalSchema = z
  .object({
    revision: z.literal(1),
    reason: z.string().trim().min(3).max(2000),
    allowException: z.boolean().default(false),
  })
  .strict();

const deliveryErrors = [
  "signed_priced_order_required",
  "delivery_already_in_progress",
  "delivery_review_not_found",
  "delivery_snapshot_changed",
  "delivery_review_expired",
  "delivery_review_superseded",
  "address_change_pending",
  "blocked_pricing",
  "stale_dependencies",
  "revision_conflict",
  "delivery_terms_changed",
  "delivery_review_reason_required",
];
export function deliveryDatabaseError(
  error: { message?: string } | null,
): void {
  if (!error) return;
  const code = deliveryErrors.find((value) => error.message?.includes(value));
  throw new PricingError(code ?? "pricing_unavailable", code ? 409 : 503);
}

/** A new delivery estimate never rewrites the signed order or its accepted quote. */
export async function previewDeliveryReview(
  db: OrgScopedClient,
  orderId: string,
  actor: string,
  body: z.infer<typeof deliveryPreviewSchema>,
  now = new Date(),
) {
  const orderResult = await db
    .from("csr_order_requests")
    .select("id,status,patient_id,pricing_quote_id,items")
    .eq("id", orderId)
    .maybeSingle();
  deliveryDatabaseError(orderResult.error);
  const order = orderResult.data;
  if (
    !order ||
    order.status !== "signed" ||
    !order.pricing_quote_id ||
    !order.patient_id
  )
    throw new PricingError("signed_priced_order_required", 409);
  const original = quoteDto(await getQuote(db, order.pricing_quote_id));
  if (
    original.status !== "bound" ||
    original.boundOrderId !== orderId ||
    original.patientId !== order.patient_id
  )
    throw new PricingError("signed_priced_order_required", 409);
  const patientResult = await db
    .from("patients")
    .select("id,address")
    .eq("id", order.patient_id)
    .maybeSingle();
  deliveryDatabaseError(patientResult.error);
  const address = patientResult.data?.address ?? null;
  const receiver = pricingShippingAddress(address);
  if (!receiver || !validateReceiverAddress(receiver).ok)
    throw new PricingError("patient_address_required");

  const offers = await listCurrentOffers(db, {
    ids: original.scenario.lines.map((line) => line.offerId),
  });
  const byId = new Map(offers.map((offer) => [offer.id, offer]));
  const state = await getPricingState(db);
  if (!state.enabled || !state.policy)
    throw new PricingError("policy_required");
  const rawRevenue = original.input.revenue;
  if (
    rawRevenue.mode !== "insurance" ||
    original.scenario.revenue.mode !== "insurance" ||
    rawRevenue.expectedCollectibleCents === null
  )
    throw new PricingError("insurance_patient_quote_required");
  const revenue: Extract<Scenario["revenue"], { mode: "insurance" }> = {
    mode: "insurance",
    expectedCollectibleCents: rawRevenue.expectedCollectibleCents,
    allowedCents: original.scenario.revenue.allowedCents,
    status: body.revenueVerification ? "verified" : rawRevenue.status,
    source:
      body.revenueVerification?.source ?? original.scenario.revenue.source,
    expiresAt:
      body.revenueVerification?.expiresAt ?? rawRevenue.expiresAt ?? undefined,
  };
  if (
    body.freight &&
    offers.some((offer) =>
      offer.components.some(
        (cost) =>
          cost.category === "freight" &&
          !cost.includedInId &&
          (cost.amountCents ?? 0) > 0,
      ),
    )
  )
    throw new PricingError("duplicate_shipping_cost");
  // A former address's manual freight is always discarded. Supplier freight
  // is revalidated by resolveScenario against the current delivery scope.
  let costs = (original.scenario.costs ?? []).filter(
    (cost) => cost.category !== "freight",
  );
  let processing = original.scenario.processing;
  let adjustments = original.scenario.adjustments;
  if (body.costVerification) {
    // This confirms known, previously verified amounts are unchanged. It
    // cannot promote a missing/estimated figure or alter any fee/reserve.
    if (
      costs.some(
        (cost) => cost.status !== "verified" || cost.amountCents === null,
      ) ||
      (processing && processing.status !== "verified") ||
      (adjustments && adjustments.status !== "verified")
    )
      throw new PricingError("verified_unchanged_costs_required");
    costs = costs.map((cost) => ({
      ...cost,
      expiresAt: body.costVerification!.expiresAt,
    }));
    if (processing)
      processing = {
        ...processing,
        expiresAt: body.costVerification.expiresAt,
      };
    if (adjustments)
      adjustments = {
        ...adjustments,
        expiresAt: body.costVerification.expiresAt,
      };
  }
  if (body.freight)
    costs.push({
      id: "delivery-review-freight",
      label: "Manager verified delivery freight",
      category: "freight",
      basis: "shipment",
      amountCents: body.freight.amountCents,
      quantity: 1,
      status: "verified",
      expiresAt: body.freight.expiresAt,
    });
  let shippingExpiry: string | undefined;
  if (body.shippingQuoteId) {
    const rate = await db
      .from("pricing_shipping_quotes")
      .select("expires_at")
      .eq("id", body.shippingQuoteId)
      .maybeSingle();
    deliveryDatabaseError(rate.error);
    if (!rate.data) throw new PricingError("shipping_quote_mismatch");
    shippingExpiry = rate.data.expires_at;
  }
  const limits = [
    state.policy.expiresAt,
    // A policy's scheduled overrides can change its rules without changing
    // the policy ID/version. Require a new review across that boundary.
    ...(state.policy.overrides ?? []).flatMap((override) =>
      [override.effectiveFrom, override.expiresAt].filter(
        (boundary) => Date.parse(boundary) > now.getTime(),
      ),
    ),
    revenue.expiresAt,
    shippingExpiry,
    processing?.expiresAt,
    adjustments?.expiresAt,
    ...offers.flatMap((offer) => [
      offer.expiresAt,
      ...offer.components.map((c) => c.expiresAt),
    ]),
    ...costs.map((cost) => cost.expiresAt),
  ].filter((value): value is string => Boolean(value));
  const expiresAt = new Date(
    Math.min(now.getTime() + 30 * 60_000, ...limits.map(Date.parse)),
  ).toISOString();
  if (Date.parse(expiresAt) <= now.getTime())
    throw new PricingError("stale_dependencies", 409);
  const scenario = scenarioSchema.parse({
    patientId: order.patient_id,
    validUntil: expiresAt,
    delivery: body.delivery,
    shippingQuoteId: body.shippingQuoteId,
    revenue,
    costs,
    processing,
    adjustments,
    lines: original.scenario.lines.map((line) => ({
      ...line,
      offerVersion: byId.get(line.offerId)?.version ?? line.offerVersion,
    })),
  });
  const resolved = await resolveScenario(db, scenario, {
    mayVerify: true,
    enforceActivePrices: false,
    preserveAcceptedUnitAmounts: true,
    now,
  });
  const result = await db
    .raw()
    .schema("resupply")
    .rpc("save_csr_delivery_review", {
      p_org_id: db.orgId,
      p_order_id: orderId,
      p_actor: actor,
      p_payload: {
        ...resolved,
        quoteRevision: original.revision,
        validUntil: expiresAt,
        approvalClass: approvalClass(resolved),
        addressSnapshot: address,
        freightSource: body.freight?.source ?? null,
        unchangedCostVerification: body.costVerification ?? null,
      } as unknown as Json,
    });
  deliveryDatabaseError(result.error);
  if (!result.data) throw new PricingError("pricing_unavailable", 503);
  return {
    reviewId: result.data.id,
    revision: 1 as const,
    expiresAt,
    approvalClass: approvalClass(resolved),
    evaluation: resolved.evaluation,
    originalEvaluation: original.evaluation,
    items: order.items,
    patientId: order.patient_id,
    addressSnapshot: address,
  };
}

export async function approveDeliveryReview(
  db: OrgScopedClient,
  orderId: string,
  reviewId: string,
  actor: string,
  body: z.infer<typeof deliveryApprovalSchema>,
) {
  const result = await db
    .raw()
    .schema("resupply")
    .rpc("approve_csr_delivery_review", {
      p_org_id: db.orgId,
      p_order_id: orderId,
      p_review_id: reviewId,
      p_actor: actor,
      p_revision: body.revision,
      p_reason: body.reason,
      p_allow_exception: body.allowException,
    });
  deliveryDatabaseError(result.error);
  if (!result.data) throw new PricingError("pricing_unavailable", 503);
  return {
    fulfillmentIds: result.data.fulfillmentIds ?? [],
    skipped: result.data.status === "queued" ? null : result.data.status,
    replayed: result.data.replayed ?? false,
  };
}
