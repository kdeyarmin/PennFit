import { evaluatePricing, PricingValidationError } from "./pricing";

export const PROVISIONAL_FEE_CATEGORIES = [
  "inbound",
  "dropship",
  "freight",
  "handling",
  "packaging",
  "other",
] as const;
export type ProvisionalSupplierFee = {
  id: string;
  label: string;
  category: (typeof PROVISIONAL_FEE_CATEGORIES)[number];
  amountCents: number | null;
  basis: "order" | "parcel" | "pack";
  /** Parcel count; order/pack fees use one charge per order/purchased pack. */
  count: number;
  includedIn?: "pack";
};
export type ProvisionalSupplierOption = {
  id: string;
  supplierName: string;
  source: string;
  expiresAt: string | null;
  packCostCents: number | null;
  unitsPerPack: number;
  minimumPacks: number;
  availability:
    | "available"
    | "limited"
    | "backorder"
    | "unavailable"
    | "unknown";
  leadTimeDays: number | null;
  terms: string;
  fees: ProvisionalSupplierFee[];
};
export type ProvisionalSupplierComparison = {
  currency: "USD";
  quantity: number;
  destination: string;
  service: string;
  suppliers: ProvisionalSupplierOption[];
};
export type ProvisionalSupplierResult = {
  id: string;
  status: "estimated" | "unknown" | "expired";
  packsToBuy: number;
  purchasedUnits: number;
  surplusUnits: number;
  goodsCostCents: number | null;
  deliveredCostCents: number | null;
  knownDeliveredCostCents: number;
  missing: string[];
  fees: Array<{
    id: string;
    extendedCostCents: number | null;
    included: boolean;
  }>;
};
export type ProvisionalComparisonResult = {
  evaluatedAt: string;
  quantity: number;
  suppliers: ProvisionalSupplierResult[];
};
function invalid(path: string, message: string): never {
  throw new PricingValidationError([{ code: "invalid_input", path, message }]);
}
function whole(value: number, path: string, minimum = 1, maximum = 10_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    invalid(path, `Enter a whole number from ${minimum} to ${maximum}.`);
}
function text(value: string, path: string, maximum: number) {
  if (typeof value !== "string" || value.length > maximum)
    invalid(path, "Text exceeds the supported length.");
}

/** Cost evidence for an unpriced item; never returns revenue, margin, a price or quote authority. */
export function compareProposedSupplierCosts(
  comparison: ProvisionalSupplierComparison,
  evaluatedAt: string,
): ProvisionalComparisonResult {
  if (comparison.currency !== "USD")
    invalid("currency", "Only USD cost comparisons are supported.");
  if (!Number.isFinite(Date.parse(evaluatedAt)))
    invalid("evaluatedAt", "A valid comparison time is required.");
  whole(comparison.quantity, "quantity");
  text(comparison.destination, "destination", 200);
  text(comparison.service, "service", 100);
  if (
    !Array.isArray(comparison.suppliers) ||
    comparison.suppliers.length < 1 ||
    comparison.suppliers.length > 5
  )
    invalid("suppliers", "Compare one to five suppliers.");
  const ids = new Set<string>();
  const suppliers = comparison.suppliers.map(
    (supplier, index): ProvisionalSupplierResult => {
      const path = `suppliers.${index}`;
      text(supplier.id, `${path}.id`, 100);
      if (!supplier.id.trim() || ids.has(supplier.id))
        invalid(`${path}.id`, "Use unique supplier identifiers.");
      ids.add(supplier.id);
      text(supplier.supplierName, `${path}.supplierName`, 200);
      text(supplier.source, `${path}.source`, 1000);
      text(supplier.terms, `${path}.terms`, 2000);
      whole(supplier.unitsPerPack, `${path}.unitsPerPack`);
      whole(supplier.minimumPacks, `${path}.minimumPacks`);
      if (supplier.leadTimeDays !== null)
        whole(supplier.leadTimeDays, `${path}.leadTimeDays`, 0, 365);
      if (
        ![
          "available",
          "limited",
          "backorder",
          "unavailable",
          "unknown",
        ].includes(supplier.availability)
      )
        invalid(`${path}.availability`, "Unknown availability.");
      if (!Array.isArray(supplier.fees) || supplier.fees.length > 20)
        invalid(`${path}.fees`, "Supply at most 20 charges.");
      const packsToBuy = Math.max(
        supplier.minimumPacks,
        Math.ceil(comparison.quantity / supplier.unitsPerPack),
      );
      const purchasedUnits = packsToBuy * supplier.unitsPerPack;
      const missing: string[] = [];
      if (!comparison.destination.trim()) missing.push("Delivery destination");
      if (!comparison.service.trim()) missing.push("Delivery service");
      if (!supplier.supplierName.trim()) missing.push("Supplier name");
      if (!supplier.source.trim()) missing.push("Supplier evidence");
      if (!supplier.expiresAt) missing.push("Evidence expiry");
      if (supplier.packCostCents === null) missing.push("Purchase pack cost");
      const feeIds = new Set<string>();
      const costs = supplier.fees.map((fee, feeIndex) => {
        if (!fee.id.trim() || feeIds.has(fee.id))
          invalid(
            `${path}.fees.${feeIndex}.id`,
            "Use unique charge identifiers.",
          );
        feeIds.add(fee.id);
        if (!PROVISIONAL_FEE_CATEGORIES.includes(fee.category))
          invalid(
            `${path}.fees.${feeIndex}.category`,
            "Unknown cost category.",
          );
        if (!["order", "parcel", "pack"].includes(fee.basis))
          invalid(`${path}.fees.${feeIndex}.basis`, "Unknown charge basis.");
        whole(
          fee.count,
          `${path}.fees.${feeIndex}.count`,
          1,
          fee.basis === "parcel" ? 10_000 : 1,
        );
        if (fee.includedIn !== undefined && fee.includedIn !== "pack")
          invalid(
            `${path}.fees.${feeIndex}.includedIn`,
            "Only inclusion in the purchase pack is supported.",
          );
        if (fee.amountCents === null && !fee.includedIn)
          missing.push(fee.label);
        return {
          id: `fee:${fee.id}`,
          label: fee.label,
          category: fee.category,
          amountCents: fee.amountCents,
          basis: "shipment" as const,
          quantity: fee.basis === "pack" ? packsToBuy : fee.count,
          status: "estimated" as const,
          includedInId: fee.includedIn ? "purchase-pack" : undefined,
        };
      });
      for (const category of PROVISIONAL_FEE_CATEGORIES) {
        if (supplier.fees.some((fee) => fee.category === category)) continue;
        missing.push(`${category} cost`);
        costs.push({
          id: `missing:${category}`,
          label: `${category} cost`,
          category,
          amountCents: null,
          basis: "shipment",
          quantity: 1,
          status: "estimated",
          includedInId: undefined,
        });
      }
      // The domain engine supplies exact extended/shared cost arithmetic. This
      // comparison has no revenue or real pricing policy and exposes no pricing states.
      const calculated = evaluatePricing({
        currency: "USD",
        evaluatedAt,
        lines: [
          {
            id: "purchase-pack",
            sku: "PROVISIONAL",
            quantity: packsToBuy,
            unitPriceCents: 0,
            unitCostCents: supplier.packCostCents,
            costStatus: "estimated",
            costExpiresAt: supplier.expiresAt,
          },
        ],
        costs,
        revenue: {
          mode: "insurance",
          expectedCollectibleCents: null,
          status: "missing",
        },
        policy: {
          targetMarginBps: 0,
          floorMarginBps: 0,
          basis: "contribution",
        },
      });
      const expired = Boolean(
        supplier.expiresAt &&
        Date.parse(supplier.expiresAt) <= Date.parse(evaluatedAt),
      );
      return {
        id: supplier.id,
        status: expired ? "expired" : missing.length ? "unknown" : "estimated",
        packsToBuy,
        purchasedUnits,
        surplusUnits: purchasedUnits - comparison.quantity,
        goodsCostCents: calculated.goodsCostCents,
        deliveredCostCents:
          !missing.length && !expired ? calculated.deliveredCostCents : null,
        knownDeliveredCostCents: calculated.knownDeliveredCostCents,
        missing,
        fees: calculated.costs.map((cost) => ({
          ...cost,
          id: cost.id.replace(/^fee:/, ""),
        })),
      };
    },
  );
  return { evaluatedAt, quantity: comparison.quantity, suppliers };
}
