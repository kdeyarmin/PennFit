// Internal pricing scenarios only; no payment collection, tax service or I/O.
// Gross-margin reporting deliberately remains in margin.ts.
export const PRICING_ENGINE_VERSION = "1";
export const PRICING_MAX_CENTS = 100_000_000_000;
const BPS = 10_000n;

export type PricingCostStatus = "verified" | "estimated" | "missing" | "stale";
export type PricingState =
  | "meets_target"
  | "approval_needed"
  | "blocked"
  | "cost_information_needed";
export type PricingBasis = "contribution" | "after_overhead";
export type PricingCostCategory =
  | "goods"
  | "inbound"
  | "dropship"
  | "freight"
  | "shipping"
  | "handling"
  | "packaging"
  | "insurance"
  | "duty"
  | "other";

export interface PricingLine {
  id: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number | null;
  costStatus: PricingCostStatus;
  costExpiresAt?: string | null;
  taxBps?: number;
}

export interface PricingCostComponent {
  id: string;
  label: string;
  category: PricingCostCategory;
  basis: "order" | "shipment" | "parcel" | "unit";
  amountCents: number | null;
  /** Count of the declared charge basis, NOT automatically the item quantity. */
  quantity?: number;
  status: PricingCostStatus;
  expiresAt?: string | null;
  source?: string;
  /** Already covered by this line's goods cost or another component. */
  includedInId?: string | null;
}

export type PricingRevenue =
  | {
      mode: "self_pay";
      shippingChargedCents: number;
      shippingTaxBps?: number;
      /** Percentage discount first, then fixed merchandise discount. */
      discountBps?: number;
      discountCents?: number;
    }
  | {
      mode: "insurance";
      /** Allowed/collectible expectation, not billed charges plus cost sharing. */
      expectedCollectibleCents: number | null;
      status: PricingCostStatus;
      expiresAt?: string | null;
    };

export interface PricingProcessingFee {
  rateBps: number;
  fixedCents: number;
  basis: "customer_total" | "net_sales" | "explicit";
  explicitBaseCents?: number;
  /** Number of equal captures if exact charge amounts are not supplied. */
  chargeCount?: number;
  /** Actual planned captures; must sum to the specified processing basis. */
  chargeAmountsCents?: readonly number[];
  status?: PricingCostStatus;
  expiresAt?: string | null;
}

export interface PricingAdjustments {
  /** Reduces revenue. Excludes refunded pass-through sales tax. */
  expectedRefundCents?: number;
  returnCostCents?: number;
  /** Supplier credits/recovered inventory value; a positive cost reduction. */
  recoveryCents?: number;
  /** Additional variable losses, excluding already modeled refunds/costs. */
  riskCostCents?: number;
  overheadCents?: number;
  /** Explicit processing-fee credit on refunds, not a second expense. */
  processingFeeCreditCents?: number;
  status?: PricingCostStatus;
  expiresAt?: string | null;
}

export interface PricingPolicy {
  targetMarginBps: number;
  floorMarginBps: number;
  /** Optional allocated-item floor; omission explicitly permits bundle subsidies. */
  lineFloorMarginBps?: number;
  minimumContributionCents?: number;
  basis: PricingBasis;
  /** Recommendation constraints apply to the selected line's UNIT price. */
  priceIncrementCents?: number;
  /** Residue within priceIncrementCents: increment=100, ending=99 => .99. */
  priceEndingCents?: number;
  priceCeilingCents?: number;
}

export interface PricingInput {
  currency: "USD";
  /** Supplied clock makes cost expiry reproducible in a saved snapshot. */
  evaluatedAt: string;
  lines: readonly PricingLine[];
  costs: readonly PricingCostComponent[];
  revenue: PricingRevenue;
  /** Omitted/null explicitly means this scenario has no processing fee. */
  processing?: PricingProcessingFee | null;
  adjustments?: PricingAdjustments;
  policy: PricingPolicy;
}

export interface PricingIssue {
  code: string;
  path: string;
  message: string;
}

export class PricingValidationError extends Error {
  constructor(public readonly issues: readonly PricingIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "PricingValidationError";
  }
}

export interface PricingLineEvaluation {
  id: string;
  sku: string;
  quantity: number;
  extendedPriceCents: number;
  discountCents: number;
  merchandiseRevenueCents: number;
  taxCents: number;
  goodsCostCents: number | null;
  /** Allocations use net merchandise revenue weights, then quantity if all zero. */
  netRevenueCents: number | null;
  /** Shared variable costs, excluding goods, recoveries and overhead. */
  allocatedSharedCostCents: number | null;
  allocatedRecoveryCents: number;
  allocatedOverheadCents: number;
  contributionCents: number | null;
  profitAfterOverheadCents: number | null;
  meetsFloor: boolean | null;
}

export interface PricingEvaluation {
  engineVersion: string;
  currency: "USD";
  state: PricingState;
  issues: PricingIssue[];
  costsComplete: boolean;
  calculationComplete: boolean;
  revenueMode: PricingRevenue["mode"];
  selectedBasis: PricingBasis;
  merchandiseSubtotalCents: number;
  discountCents: number;
  merchandiseRevenueCents: number;
  shippingChargedCents: number;
  /** Before expected refunds, excluding pass-through tax. */
  originalRevenueCents: number | null;
  expectedRefundCents: number;
  netRevenueCents: number | null;
  taxCents: number;
  /** Null for insurance: this calculation does not establish patient liability. */
  customerTotalCents: number | null;
  goodsCostCents: number | null;
  additionalFulfillmentCostCents: number | null;
  deliveredCostCents: number | null;
  knownDeliveredCostCents: number;
  processingBaseCents: number | null;
  processingFeeCents: number | null;
  returnCostCents: number;
  recoveryCents: number;
  riskCostCents: number;
  overheadCents: number;
  totalVariableCostCents: number | null;
  contributionCents: number | null;
  /** Display only; all policy comparisons use integer cross multiplication. */
  contributionMarginBps: number | null;
  profitAfterOverheadCents: number | null;
  selectedBasisProfitCents: number | null;
  selectedBasisMarginBps: number | null;
  meetsTarget: boolean | null;
  meetsFloor: boolean | null;
  meetsLineFloors: boolean | null;
  meetsMinimumContribution: boolean | null;
  /** Fixed-revenue cost ceiling, possibly negative when no cost can qualify. */
  maximumDeliveredCostCents: number | null;
  lines: PricingLineEvaluation[];
  costs: Array<{
    id: string;
    extendedCostCents: number | null;
    included: boolean;
  }>;
}

export interface PricingRecommendation {
  status:
    | "recommended"
    | "fixed_revenue"
    | "cost_information_needed"
    | "selection_required"
    | "fixed_capture_amounts"
    | "ceiling_exceeded"
    | "no_qualifying_price";
  lineId: string | null;
  recommendedUnitPriceCents: number | null;
  recommendedInput: PricingInput | null;
  evaluation: PricingEvaluation;
}

function invalid(path: string, message: string): never {
  throw new PricingValidationError([{ code: "invalid_input", path, message }]);
}

function integer(
  value: number,
  path: string,
  max = PRICING_MAX_CENTS,
  min = 0,
) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalid(path, `Must be an integer between ${min} and ${max}.`);
  return value;
}

function cents(value: number, path: string) {
  return integer(value, path);
}

function checked(value: bigint, path = "total"): number {
  if (value > BigInt(PRICING_MAX_CENTS) || value < -BigInt(PRICING_MAX_CENTS))
    invalid(path, "Calculated amount exceeds the supported money limit.");
  return Number(value);
}

function sum(values: readonly number[], path = "total"): number {
  return checked(
    values.reduce((total, value) => total + BigInt(value), 0n),
    path,
  );
}

/** Nonnegative percentages round half up once at the actual charge boundary. */
function percentage(amount: number, bps: number): number {
  return checked((BigInt(amount) * BigInt(bps) + BPS / 2n) / BPS);
}

function date(value: string, path: string): number {
  const parts =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
          value,
        )
      : null;
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (!parts || !Number.isFinite(at))
    invalid(path, "A timestamp with an explicit timezone is required.");
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1])
    invalid(path, "The timestamp must identify a real calendar date.");
  return at;
}

function status(value: PricingCostStatus, path: string) {
  if (!["verified", "estimated", "missing", "stale"].includes(value))
    invalid(path, "Unknown verification status.");
}

function textId(value: string, path: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 160)
    invalid(
      path,
      "A nonblank identifier of at most 160 characters is required.",
    );
}

/** Stable largest remainder: exact total, ties resolved by input order. */
export function allocatePricingCents(
  totalCents: number,
  weights: readonly number[],
): number[] {
  cents(totalCents, "totalCents");
  if (!Array.isArray(weights) || !weights.length || weights.length > 1_000)
    invalid("weights", "Supply between one and 1,000 allocation weights.");
  weights.forEach((weight, index) => integer(weight, `weights.${index}`));
  const denominator = weights.reduce(
    (total, weight) => total + BigInt(weight),
    0n,
  );
  if (denominator === 0n) {
    if (totalCents === 0) return weights.map(() => 0);
    invalid("weights", "A nonzero allocation requires a positive weight.");
  }
  const rows = weights.map((weight, index) => {
    const numerator = BigInt(totalCents) * BigInt(weight);
    return {
      index,
      amount: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });
  let remaining =
    totalCents - rows.reduce((total, row) => total + row.amount, 0);
  const sorted = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const row of sorted) {
    if (!remaining) break;
    rows[row.index].amount += 1;
    remaining -= 1;
  }
  return rows.map((row) => row.amount);
}

function validate(input: PricingInput) {
  if (input.currency !== "USD")
    invalid("currency", "Only USD scenarios are supported.");
  date(input.evaluatedAt, "evaluatedAt");
  if (
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > 200
  )
    invalid("lines", "Supply between one and 200 item lines.");
  if (!Array.isArray(input.costs) || input.costs.length > 500)
    invalid("costs", "Supply at most 500 additional cost components.");
  const ids = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    const path = `lines.${index}`;
    textId(line.id, `${path}.id`);
    textId(line.sku, `${path}.sku`);
    if (ids.has(line.id)) invalid(`${path}.id`, "IDs must be unique.");
    ids.add(line.id);
    integer(line.quantity, `${path}.quantity`, 100_000, 1);
    cents(line.unitPriceCents, `${path}.unitPriceCents`);
    if (line.unitCostCents !== null)
      cents(line.unitCostCents, `${path}.unitCostCents`);
    status(line.costStatus, `${path}.costStatus`);
    integer(line.taxBps ?? 0, `${path}.taxBps`, 10_000);
    if (line.costExpiresAt != null)
      date(line.costExpiresAt, `${path}.costExpiresAt`);
  }
  for (const [index, cost] of input.costs.entries()) {
    const path = `costs.${index}`;
    textId(cost.id, `${path}.id`);
    if (ids.has(cost.id)) invalid(`${path}.id`, "IDs must be unique.");
    ids.add(cost.id);
    textId(cost.label, `${path}.label`);
    if (
      ![
        "goods",
        "inbound",
        "dropship",
        "freight",
        "shipping",
        "handling",
        "packaging",
        "insurance",
        "duty",
        "other",
      ].includes(cost.category)
    )
      invalid(`${path}.category`, "Unknown cost category.");
    if (!["order", "shipment", "parcel", "unit"].includes(cost.basis))
      invalid(`${path}.basis`, "Unknown charge basis.");
    integer(
      cost.quantity ?? 1,
      `${path}.quantity`,
      cost.basis === "order" ? 1 : 100_000,
      1,
    );
    if (cost.amountCents !== null)
      cents(cost.amountCents, `${path}.amountCents`);
    status(cost.status, `${path}.status`);
    if (cost.expiresAt != null) date(cost.expiresAt, `${path}.expiresAt`);
  }
  const components = new Map(input.costs.map((cost) => [cost.id, cost]));
  for (const cost of input.costs) {
    const visited = new Set([cost.id]);
    let owner = cost.includedInId;
    while (owner != null) {
      if (!ids.has(owner) || visited.has(owner))
        invalid(
          `costs.${cost.id}.includedInId`,
          "Included costs must reference a distinct existing cost without a cycle.",
        );
      visited.add(owner);
      owner = components.get(owner)?.includedInId;
    }
  }
  const revenue = input.revenue;
  if (revenue.mode === "self_pay") {
    cents(revenue.shippingChargedCents, "revenue.shippingChargedCents");
    cents(revenue.discountCents ?? 0, "revenue.discountCents");
    integer(revenue.discountBps ?? 0, "revenue.discountBps", 10_000);
    integer(revenue.shippingTaxBps ?? 0, "revenue.shippingTaxBps", 10_000);
  } else if (revenue.mode === "insurance") {
    if (revenue.expectedCollectibleCents !== null)
      cents(
        revenue.expectedCollectibleCents,
        "revenue.expectedCollectibleCents",
      );
    status(revenue.status, "revenue.status");
    if (revenue.expiresAt != null) date(revenue.expiresAt, "revenue.expiresAt");
  } else invalid("revenue.mode", "Unknown revenue mode.");
  const policy = input.policy;
  integer(policy.targetMarginBps, "policy.targetMarginBps", 9_999);
  integer(
    policy.floorMarginBps,
    "policy.floorMarginBps",
    policy.targetMarginBps,
  );
  if (policy.lineFloorMarginBps != null)
    integer(policy.lineFloorMarginBps, "policy.lineFloorMarginBps", 9_999);
  cents(
    policy.minimumContributionCents ?? 0,
    "policy.minimumContributionCents",
  );
  if (!["contribution", "after_overhead"].includes(policy.basis))
    invalid("policy.basis", "Unknown margin basis.");
  const increment = integer(
    policy.priceIncrementCents ?? 1,
    "policy.priceIncrementCents",
    1_000_000,
    1,
  );
  integer(
    policy.priceEndingCents ?? 0,
    "policy.priceEndingCents",
    increment - 1,
  );
  if (policy.priceCeilingCents != null)
    cents(policy.priceCeilingCents, "policy.priceCeilingCents");
  if (input.processing) {
    const fee = input.processing;
    integer(fee.rateBps, "processing.rateBps", 10_000);
    cents(fee.fixedCents, "processing.fixedCents");
    integer(fee.chargeCount ?? 1, "processing.chargeCount", 100, 1);
    if (!["customer_total", "net_sales", "explicit"].includes(fee.basis))
      invalid("processing.basis", "Unknown fee basis.");
    if (fee.basis === "explicit")
      cents(fee.explicitBaseCents as number, "processing.explicitBaseCents");
    else if (fee.explicitBaseCents != null)
      invalid(
        "processing.explicitBaseCents",
        "An explicit amount requires the explicit fee basis.",
      );
    if (fee.status != null) status(fee.status, "processing.status");
    if (fee.expiresAt != null) date(fee.expiresAt, "processing.expiresAt");
    if (fee.chargeAmountsCents) {
      if (!fee.chargeAmountsCents.length || fee.chargeAmountsCents.length > 100)
        invalid(
          "processing.chargeAmountsCents",
          "Supply between one and 100 capture amounts.",
        );
      fee.chargeAmountsCents.forEach((amount, index) =>
        cents(amount, `processing.chargeAmountsCents.${index}`),
      );
      if (
        fee.chargeCount != null &&
        fee.chargeCount !== fee.chargeAmountsCents.length
      )
        invalid(
          "processing.chargeCount",
          "Capture count must match supplied amounts.",
        );
    }
  }
  const adjustments = input.adjustments;
  if (adjustments) {
    for (const key of [
      "expectedRefundCents",
      "returnCostCents",
      "recoveryCents",
      "riskCostCents",
      "overheadCents",
      "processingFeeCreditCents",
    ] as const)
      cents(adjustments[key] ?? 0, `adjustments.${key}`);
    if (adjustments.status != null)
      status(adjustments.status, "adjustments.status");
    if (adjustments.expiresAt != null)
      date(adjustments.expiresAt, "adjustments.expiresAt");
  }
}

function checkQuality(
  issues: PricingIssue[],
  amount: number | null,
  quality: PricingCostStatus,
  expiresAt: string | null | undefined,
  now: number,
  path: string,
) {
  if (amount === null || quality === "missing")
    issues.push({
      code: "missing_input",
      path,
      message: "A required amount or verification is missing.",
    });
  else if (
    quality === "stale" ||
    (expiresAt != null && date(expiresAt, path) <= now)
  )
    issues.push({
      code: "stale_input",
      path,
      message: "Refresh the expired cost, rate or revenue expectation.",
    });
  else if (quality === "estimated")
    issues.push({
      code: "estimated_input",
      path,
      message: "This estimate requires explicit review before a firm quote.",
    });
}

function ratio(profit: number | null, revenue: number | null) {
  return profit === null || revenue === null || revenue <= 0
    ? null
    : (profit / revenue) * 10_000;
}

function meets(profit: number, revenue: number, target: number) {
  return (
    revenue > 0 && BigInt(profit) * BPS >= BigInt(revenue) * BigInt(target)
  );
}

export function evaluatePricing(input: PricingInput): PricingEvaluation {
  validate(input);
  const now = date(input.evaluatedAt, "evaluatedAt");
  const issues: PricingIssue[] = [];
  const extended = input.lines.map((line) =>
    checked(BigInt(line.unitPriceCents) * BigInt(line.quantity)),
  );
  const merchandiseSubtotalCents = sum(extended);
  const selfPay = input.revenue.mode === "self_pay" ? input.revenue : null;
  const discountCents = selfPay
    ? sum([
        percentage(merchandiseSubtotalCents, selfPay.discountBps ?? 0),
        selfPay.discountCents ?? 0,
      ])
    : 0;
  if (discountCents > merchandiseSubtotalCents)
    invalid(
      "revenue.discountCents",
      "Discounts cannot exceed merchandise sales.",
    );
  const discounts = discountCents
    ? allocatePricingCents(discountCents, extended)
    : extended.map(() => 0);
  const lineResults: PricingLineEvaluation[] = input.lines.map(
    (line, index) => {
      checkQuality(
        issues,
        line.unitCostCents,
        line.costStatus,
        line.costExpiresAt,
        now,
        `lines.${index}.unitCostCents`,
      );
      const merchandiseRevenueCents = extended[index] - discounts[index];
      return {
        id: line.id,
        sku: line.sku,
        quantity: line.quantity,
        extendedPriceCents: extended[index],
        discountCents: discounts[index],
        merchandiseRevenueCents,
        taxCents: selfPay
          ? percentage(merchandiseRevenueCents, line.taxBps ?? 0)
          : 0,
        goodsCostCents:
          line.unitCostCents === null
            ? null
            : checked(BigInt(line.unitCostCents) * BigInt(line.quantity)),
        netRevenueCents: null,
        allocatedSharedCostCents: null,
        allocatedRecoveryCents: 0,
        allocatedOverheadCents: 0,
        contributionCents: null,
        profitAfterOverheadCents: null,
        meetsFloor: null,
      };
    },
  );
  const costResults = input.costs.map((cost, index) => {
    const included = cost.includedInId != null;
    if (!included)
      checkQuality(
        issues,
        cost.amountCents,
        cost.status,
        cost.expiresAt,
        now,
        `costs.${index}.amountCents`,
      );
    return {
      id: cost.id,
      included,
      extendedCostCents: included
        ? 0
        : cost.amountCents === null
          ? null
          : checked(BigInt(cost.amountCents) * BigInt(cost.quantity ?? 1)),
    };
  });
  const goodsKnown = lineResults.every((line) => line.goodsCostCents !== null);
  const extraKnown = costResults.every(
    (cost) => cost.extendedCostCents !== null,
  );
  const goodsCostCents = goodsKnown
    ? sum(lineResults.map((line) => line.goodsCostCents!))
    : null;
  const additionalFulfillmentCostCents = extraKnown
    ? sum(costResults.map((cost) => cost.extendedCostCents!))
    : null;
  const knownDeliveredCostCents = sum([
    ...lineResults.map((line) => line.goodsCostCents ?? 0),
    ...costResults.map((cost) => cost.extendedCostCents ?? 0),
  ]);
  const deliveredCostCents =
    goodsKnown && extraKnown ? knownDeliveredCostCents : null;
  const merchandiseRevenueCents = merchandiseSubtotalCents - discountCents;
  const shippingChargedCents = selfPay?.shippingChargedCents ?? 0;
  const taxCents = sum([
    ...lineResults.map((line) => line.taxCents),
    selfPay ? percentage(shippingChargedCents, selfPay.shippingTaxBps ?? 0) : 0,
  ]);
  const originalRevenueCents =
    input.revenue.mode === "insurance"
      ? input.revenue.expectedCollectibleCents
      : sum([merchandiseRevenueCents, shippingChargedCents]);
  if (input.revenue.mode === "insurance")
    checkQuality(
      issues,
      originalRevenueCents,
      input.revenue.status,
      input.revenue.expiresAt,
      now,
      "revenue.expectedCollectibleCents",
    );
  const expectedRefundCents = input.adjustments?.expectedRefundCents ?? 0;
  if (
    originalRevenueCents !== null &&
    expectedRefundCents > originalRevenueCents
  )
    invalid(
      "adjustments.expectedRefundCents",
      "Expected revenue reversals cannot exceed original revenue.",
    );
  const netRevenueCents =
    originalRevenueCents === null
      ? null
      : originalRevenueCents - expectedRefundCents;
  const customerTotalCents =
    selfPay && originalRevenueCents !== null
      ? sum([originalRevenueCents, taxCents])
      : null;
  const fee = input.processing;
  const processingBaseCents = !fee
    ? 0
    : fee.basis === "explicit"
      ? fee.explicitBaseCents!
      : fee.basis === "customer_total"
        ? originalRevenueCents === null
          ? null
          : sum([originalRevenueCents, taxCents])
        : originalRevenueCents;
  let processingFeeCents: number | null = 0;
  if (fee) {
    checkQuality(
      issues,
      processingBaseCents,
      fee.status ?? "verified",
      fee.expiresAt,
      now,
      "processing",
    );
    if (processingBaseCents === null) processingFeeCents = null;
    else {
      const charges =
        fee.chargeAmountsCents ??
        allocatePricingCents(
          processingBaseCents,
          Array.from({ length: fee.chargeCount ?? 1 }, () => 1),
        );
      if (sum(charges) !== processingBaseCents)
        invalid(
          "processing.chargeAmountsCents",
          "Capture amounts must sum to the processing basis.",
        );
      processingFeeCents = sum(
        charges.map((amount) =>
          sum([percentage(amount, fee.rateBps), fee.fixedCents]),
        ),
      );
    }
  }
  const feeCredit = input.adjustments?.processingFeeCreditCents ?? 0;
  if (processingFeeCents !== null) {
    if (feeCredit > processingFeeCents)
      invalid(
        "adjustments.processingFeeCreditCents",
        "Fee credits cannot exceed the original processing fee.",
      );
    processingFeeCents -= feeCredit;
  }
  const returnCostCents = input.adjustments?.returnCostCents ?? 0;
  const recoveryCents = input.adjustments?.recoveryCents ?? 0;
  const riskCostCents = input.adjustments?.riskCostCents ?? 0;
  const overheadCents = input.adjustments?.overheadCents ?? 0;
  if (input.adjustments)
    checkQuality(
      issues,
      0,
      input.adjustments.status ?? "verified",
      input.adjustments.expiresAt,
      now,
      "adjustments",
    );
  const totalVariableCostCents =
    deliveredCostCents === null || processingFeeCents === null
      ? null
      : sum([
          deliveredCostCents,
          processingFeeCents,
          returnCostCents,
          riskCostCents,
          -recoveryCents,
        ]);
  const contributionCents =
    netRevenueCents === null || totalVariableCostCents === null
      ? null
      : sum([netRevenueCents, -totalVariableCostCents]);
  const profitAfterOverheadCents =
    contributionCents === null
      ? null
      : sum([contributionCents, -overheadCents]);
  const selectedBasisProfitCents =
    input.policy.basis === "after_overhead"
      ? profitAfterOverheadCents
      : contributionCents;
  const calculationComplete =
    selectedBasisProfitCents !== null && netRevenueCents !== null;
  const costsComplete = issues.length === 0;
  const meetsTarget = calculationComplete
    ? meets(
        selectedBasisProfitCents!,
        netRevenueCents!,
        input.policy.targetMarginBps,
      )
    : null;
  const meetsFloor = calculationComplete
    ? meets(
        selectedBasisProfitCents!,
        netRevenueCents!,
        input.policy.floorMarginBps,
      )
    : null;
  const meetsMinimumContribution =
    contributionCents === null
      ? null
      : contributionCents >= (input.policy.minimumContributionCents ?? 0);
  // Every allocation reconciles to its order total, including insurance
  // collections, customer shipping, refunds, credits and overhead. These are
  // reporting allocations, not a determination of payer/patient liability.
  const weights = lineResults.some((line) => line.merchandiseRevenueCents > 0)
    ? lineResults.map((line) => line.merchandiseRevenueCents)
    : input.lines.map((line) => line.quantity);
  const revenues =
    netRevenueCents === null
      ? null
      : allocatePricingCents(netRevenueCents, weights);
  const recoveries = allocatePricingCents(recoveryCents, weights);
  const overheads = allocatePricingCents(overheadCents, weights);
  const shared =
    additionalFulfillmentCostCents === null || processingFeeCents === null
      ? null
      : allocatePricingCents(
          sum([
            additionalFulfillmentCostCents,
            processingFeeCents,
            returnCostCents,
            riskCostCents,
          ]),
          weights,
        );
  lineResults.forEach((line, index) => {
    line.netRevenueCents = revenues?.[index] ?? null;
    line.allocatedSharedCostCents = shared?.[index] ?? null;
    line.allocatedRecoveryCents = recoveries[index];
    line.allocatedOverheadCents = overheads[index];
    line.contributionCents =
      line.goodsCostCents === null || !shared || !revenues
        ? null
        : sum([
            revenues[index],
            -line.goodsCostCents,
            -shared[index],
            recoveries[index],
          ]);
    line.profitAfterOverheadCents =
      line.contributionCents === null
        ? null
        : sum([line.contributionCents, -overheads[index]]);
    const profit =
      input.policy.basis === "after_overhead"
        ? line.profitAfterOverheadCents
        : line.contributionCents;
    line.meetsFloor =
      input.policy.lineFloorMarginBps == null
        ? true
        : profit === null || line.netRevenueCents === null
          ? null
          : meets(
              profit,
              line.netRevenueCents,
              input.policy.lineFloorMarginBps,
            );
  });
  const meetsLineFloors = lineResults.some((line) => line.meetsFloor === false)
    ? false
    : lineResults.some((line) => line.meetsFloor === null)
      ? null
      : true;
  let state: PricingState;
  if (!costsComplete) state = "cost_information_needed";
  else if (
    netRevenueCents === 0 ||
    !meetsFloor ||
    !meetsLineFloors ||
    !meetsMinimumContribution
  )
    state = "blocked";
  else state = meetsTarget ? "meets_target" : "approval_needed";
  if (netRevenueCents === 0)
    issues.push({
      code: "zero_revenue",
      path: "revenue",
      message: "Zero net revenue has no meaningful margin percentage.",
    });
  if (meetsFloor === false)
    issues.push({
      code: "below_floor",
      path: "policy.floorMarginBps",
      message: "This scenario is below the hard margin floor.",
    });
  if (meetsMinimumContribution === false)
    issues.push({
      code: "below_minimum_contribution",
      path: "policy.minimumContributionCents",
      message: "Contribution dollars are below the required minimum.",
    });
  if (meetsLineFloors === false)
    issues.push({
      code: "below_line_floor",
      path: "policy.lineFloorMarginBps",
      message: "An allocated item margin is below the required floor.",
    });
  if (meetsTarget === false)
    issues.push({
      code: "below_target",
      path: "policy.targetMarginBps",
      message: "This scenario does not meet the target margin.",
    });
  let maximumDeliveredCostCents: number | null = null;
  if (
    netRevenueCents !== null &&
    netRevenueCents > 0 &&
    processingFeeCents !== null
  ) {
    const targetProfit = checked(
      (BigInt(netRevenueCents) * BigInt(input.policy.targetMarginBps) +
        BPS -
        1n) /
        BPS,
    );
    const selectedOverhead =
      input.policy.basis === "after_overhead" ? overheadCents : 0;
    const requiredContribution = Math.max(
      targetProfit + selectedOverhead,
      input.policy.minimumContributionCents ?? 0,
    );
    maximumDeliveredCostCents = sum([
      netRevenueCents,
      -processingFeeCents,
      -returnCostCents,
      -riskCostCents,
      recoveryCents,
      -requiredContribution,
    ]);
  }
  return {
    engineVersion: PRICING_ENGINE_VERSION,
    currency: "USD",
    state,
    issues,
    costsComplete,
    calculationComplete,
    revenueMode: input.revenue.mode,
    selectedBasis: input.policy.basis,
    merchandiseSubtotalCents,
    discountCents,
    merchandiseRevenueCents,
    shippingChargedCents,
    originalRevenueCents,
    expectedRefundCents,
    netRevenueCents,
    taxCents,
    customerTotalCents,
    goodsCostCents,
    additionalFulfillmentCostCents,
    deliveredCostCents,
    knownDeliveredCostCents,
    processingBaseCents,
    processingFeeCents,
    returnCostCents,
    recoveryCents,
    riskCostCents,
    overheadCents,
    totalVariableCostCents,
    contributionCents,
    contributionMarginBps: ratio(contributionCents, netRevenueCents),
    profitAfterOverheadCents,
    selectedBasisProfitCents,
    selectedBasisMarginBps: ratio(selectedBasisProfitCents, netRevenueCents),
    meetsTarget,
    meetsFloor,
    meetsLineFloors,
    meetsMinimumContribution,
    maximumDeliveredCostCents,
    lines: lineResults,
    costs: costResults,
  };
}

/**
 * Find a verified qualifying unit price for one selected item, retaining the
 * remaining basket exactly. It is not a claim of a globally minimal price:
 * rounded fees create small discontinuities. Resolve changing supplier tiers,
 * shipping thresholds and shipment alternatives as separate input scenarios.
 */
export function recommendPricing(
  input: PricingInput,
  lineId?: string,
): PricingRecommendation {
  const evaluation = evaluatePricing(input);
  const result = (
    status: PricingRecommendation["status"],
    selected: string | null = lineId ?? null,
  ): PricingRecommendation => ({
    status,
    lineId: selected,
    recommendedUnitPriceCents: null,
    recommendedInput: null,
    evaluation,
  });
  if (input.revenue.mode === "insurance") return result("fixed_revenue");
  if (!evaluation.costsComplete || !evaluation.calculationComplete)
    return result("cost_information_needed");
  const selectedId =
    lineId ?? (input.lines.length === 1 ? input.lines[0].id : null);
  if (!selectedId) return result("selection_required");
  const index = input.lines.findIndex((line) => line.id === selectedId);
  if (index < 0)
    invalid("lineId", "The selected item does not exist in this scenario.");
  const increment = input.policy.priceIncrementCents ?? 1;
  const ending = input.policy.priceEndingCents ?? 0;
  const otherSubtotal = sum(
    input.lines
      .filter((_, i) => i !== index)
      .map((line) =>
        checked(BigInt(line.unitPriceCents) * BigInt(line.quantity)),
      ),
  );
  const amountLimit = Math.floor(
    (PRICING_MAX_CENTS - otherSubtotal) / input.lines[index].quantity,
  );
  const ceiling = Math.min(
    input.policy.priceCeilingCents ?? amountLimit,
    amountLimit,
  );
  const maximumTick = Math.floor((ceiling - ending) / increment);
  const currentPrice = input.lines[index].unitPriceCents;
  const currentAllowed =
    currentPrice <= ceiling &&
    currentPrice >= ending &&
    (currentPrice - ending) % increment === 0;
  const currentRecommendation = (): PricingRecommendation => ({
    status: "recommended",
    lineId: selectedId,
    recommendedUnitPriceCents: currentPrice,
    recommendedInput: {
      ...input,
      lines: input.lines.map((line) => ({ ...line })),
    },
    evaluation,
  });
  // Actual capture amounts constrain the payment base. Never silently resize
  // them to manufacture a new qualifying price or report a false price ceiling.
  if (
    input.processing?.chargeAmountsCents &&
    input.processing.basis !== "explicit"
  ) {
    return currentAllowed && evaluation.state === "meets_target"
      ? currentRecommendation()
      : result("fixed_capture_amounts", selectedId);
  }
  const candidate = (tick: number) => {
    const price = tick * increment + ending;
    const next: PricingInput = {
      ...input,
      lines: input.lines.map((line, i) =>
        i === index ? { ...line, unitPriceCents: price } : { ...line },
      ),
    };
    try {
      const evaluated = evaluatePricing(next);
      return {
        input: next,
        evaluation: evaluated,
        price,
        passes: evaluated.state === "meets_target",
      };
    } catch (error) {
      if (!(error instanceof PricingValidationError)) throw error;
      return null;
    }
  };
  if (maximumTick < 0) return result("ceiling_exceeded", selectedId);
  // Exponential bracketing keeps large supported ranges bounded. An explicit
  // ceiling is always evaluated; no unverified formula result is returned.
  let lower = -1;
  let upper = 0;
  let qualifying = candidate(upper);
  // Use the selected order objective to seed discontinuous scenarios before
  // bracketing. Recovery allocations and item floors can create a valid band
  // that powers of two alone would jump over. This estimate is never returned
  // without applying all rounded charges and item/order constraints.
  const q = BigInt(input.lines[index].quantity);
  const retained = BPS - BigInt(input.revenue.discountBps ?? 0);
  const feeRate = BigInt(
    input.processing?.basis === "explicit"
      ? 0
      : (input.processing?.rateBps ?? 0),
  );
  const feeTax =
    input.processing?.basis === "customer_total"
      ? BPS + BigInt(input.lines[index].taxBps ?? 0)
      : BPS;
  const seedFor = (marginBps: number, profit: number, minimum: number) => {
    const slope =
      q * retained * ((BPS - BigInt(marginBps)) * BPS - feeRate * feeTax);
    if (slope <= 0n) return null;
    const deficit =
      BigInt(evaluation.netRevenueCents!) * BigInt(marginBps) -
      (BigInt(profit) - BigInt(minimum)) * BPS;
    const numerator = deficit * BPS * BPS;
    // Integer division truncates toward zero; ceil correctly for either sign.
    const delta =
      numerator > 0n ? (numerator + slope - 1n) / slope : numerator / slope;
    const estimate = BigInt(currentPrice) + delta;
    return Number(
      estimate < 0n
        ? 0n
        : estimate > BigInt(ceiling)
          ? BigInt(ceiling)
          : estimate,
    );
  };
  const marginSeed = seedFor(
    input.policy.targetMarginBps,
    evaluation.selectedBasisProfitCents!,
    0,
  );
  const dollarSeed = seedFor(
    0,
    evaluation.contributionCents!,
    input.policy.minimumContributionCents ?? 0,
  );
  const seed =
    marginSeed === null && dollarSeed === null
      ? null
      : Math.max(marginSeed ?? 0, dollarSeed ?? 0);
  if (seed !== null && !qualifying?.passes) {
    const seedTick = Math.max(
      0,
      Math.min(maximumTick, Math.ceil((seed - ending) / increment)),
    );
    for (
      let tick = Math.max(0, seedTick - 32);
      tick <= Math.min(maximumTick, seedTick + 32);
      tick++
    ) {
      const tested = candidate(tick);
      if (tested?.passes) {
        upper = tick;
        qualifying = tested;
        break;
      }
    }
  }
  for (let attempts = 0; !qualifying?.passes && attempts < 48; attempts++) {
    if (upper >= maximumTick) break;
    lower = upper;
    upper = Math.min(maximumTick, upper === 0 ? 1 : upper * 2);
    qualifying = candidate(upper);
  }
  if (
    !qualifying?.passes &&
    currentAllowed &&
    evaluation.state === "meets_target"
  )
    return currentRecommendation();
  if (!qualifying?.passes)
    return result(
      input.policy.priceCeilingCents != null
        ? "ceiling_exceeded"
        : "no_qualifying_price",
      selectedId,
    );
  while (upper - lower > 1) {
    const middle = Math.floor((upper + lower) / 2);
    const tested = candidate(middle);
    if (tested?.passes) {
      upper = middle;
      qualifying = tested;
    } else lower = middle;
  }
  // Inspect a bounded neighborhood to avoid obvious penny overpricing from
  // fee rounding; acceptance still depends only on the exact evaluator.
  for (let tick = Math.max(0, upper - 32); tick < upper; tick++) {
    const tested = candidate(tick);
    if (tested?.passes) {
      qualifying = tested;
      break;
    }
  }
  return {
    status: "recommended",
    lineId: selectedId,
    recommendedUnitPriceCents: qualifying.price,
    recommendedInput: qualifying.input,
    evaluation: qualifying.evaluation,
  };
}
