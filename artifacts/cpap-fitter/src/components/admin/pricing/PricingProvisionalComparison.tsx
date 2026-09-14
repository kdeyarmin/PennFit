import {
  compareProposedSupplierCosts,
  PROVISIONAL_FEE_CATEGORIES,
  type ProvisionalSupplierComparison,
  type ProvisionalSupplierOption,
  type ProvisionalComparisonResult,
  type ProvisionalSupplierFee,
} from "@workspace/api-client-react/admin";
import {
  formatPricingMoney,
  parsePricingMoney,
  pricingExpiry,
} from "@/lib/admin/pricing-input";
import { Button } from "../Button";
import { PricingField, pricingControl } from "./PricingPrimitives";

const feeLabels = {
  inbound: "Inbound freight",
  dropship: "Dropship",
  freight: "Delivery freight",
  handling: "Handling",
  packaging: "Packaging",
  other: "Other charges",
};
type SupplierDraft = Omit<
  ProvisionalSupplierOption,
  | "packCostCents"
  | "unitsPerPack"
  | "minimumPacks"
  | "expiresAt"
  | "leadTimeDays"
  | "fees"
> & {
  packCost: string;
  unitsPerPack: string;
  minimumPacks: string;
  expires: string;
  leadTimeDays: string;
  fees: Array<
    Omit<ProvisionalSupplierFee, "amountCents" | "count"> & {
      amount: string;
      count: string;
    }
  >;
};
export type ProvisionalComparisonDraft = {
  quantity: string;
  destination: string;
  service: string;
  suppliers: SupplierDraft[];
};
function supplierDraft(): SupplierDraft {
  return {
    id: crypto.randomUUID(),
    supplierName: "",
    source: "",
    packCost: "",
    unitsPerPack: "1",
    minimumPacks: "1",
    expires: "",
    availability: "unknown",
    leadTimeDays: "",
    terms: "",
    fees: PROVISIONAL_FEE_CATEGORIES.map((category) => ({
      id: category,
      label: feeLabels[category],
      category,
      amount: "",
      basis: "order",
      count: "1",
    })),
  };
}
export function newProvisionalComparison(): ProvisionalComparisonDraft {
  return {
    quantity: "1",
    destination: "",
    service: "",
    suppliers: [supplierDraft()],
  };
}
function whole(
  value: string,
  label: string,
  minimum = 1,
  maximum = 10_000,
): number {
  const result = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  )
    throw new Error(
      `${label}: enter a whole number from ${minimum} to ${maximum}.`,
    );
  return result;
}
function money(value: string, label: string): number | null {
  const amount = parsePricingMoney(value);
  if (value.trim() && amount === null)
    throw new Error(
      `${label}: enter a nonnegative dollar amount with at most two decimal places.`,
    );
  return amount;
}
export function readProvisionalComparison(draft: ProvisionalComparisonDraft): {
  input: ProvisionalSupplierComparison;
  result: ProvisionalComparisonResult;
} {
  const input: ProvisionalSupplierComparison = {
    currency: "USD",
    quantity: whole(draft.quantity, "Requested units"),
    destination: draft.destination.trim(),
    service: draft.service.trim(),
    suppliers: draft.suppliers.map((supplier, index) => {
      const prefix = `Supplier ${index + 1}`;
      const expiresAt = supplier.expires
        ? pricingExpiry(supplier.expires)
        : null;
      if (supplier.expires && !expiresAt)
        throw new Error(`${prefix}: enter a real evidence expiry date.`);
      return {
        id: supplier.id,
        supplierName: supplier.supplierName.trim(),
        source: supplier.source.trim(),
        packCostCents: money(supplier.packCost, `${prefix} pack cost`),
        unitsPerPack: whole(supplier.unitsPerPack, `${prefix} units per pack`),
        minimumPacks: whole(supplier.minimumPacks, `${prefix} minimum packs`),
        expiresAt,
        availability: supplier.availability,
        leadTimeDays: supplier.leadTimeDays
          ? whole(supplier.leadTimeDays, `${prefix} lead time`, 0, 365)
          : null,
        terms: supplier.terms.trim(),
        fees: supplier.fees.map((fee) => ({
          id: fee.id,
          label: fee.label,
          category: fee.category,
          amountCents: fee.includedIn
            ? null
            : money(fee.amount, `${prefix} ${fee.label}`),
          basis: fee.basis,
          count:
            fee.basis === "parcel"
              ? whole(fee.count, `${prefix} parcel count`)
              : 1,
          ...(fee.includedIn ? { includedIn: fee.includedIn } : {}),
        })),
      };
    }),
  };
  return {
    input,
    result: compareProposedSupplierCosts(input, new Date().toISOString()),
  };
}
export function ProvisionalComparisonSummary({
  comparison,
}: {
  comparison: ProvisionalSupplierComparison;
  result?: ProvisionalComparisonResult;
}) {
  let calculated: ProvisionalComparisonResult | undefined;
  try {
    calculated = compareProposedSupplierCosts(
      comparison,
      new Date().toISOString(),
    );
  } catch {
    /* A malformed historical comparison remains visibly incomplete. */
    calculated = undefined;
  }
  if (!calculated)
    return (
      <p className="text-sm text-amber-800">
        The saved cost comparison needs updated information.
      </p>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Provisional costs for {comparison.quantity} requested units ·{" "}
        {comparison.destination || "Destination unknown"} ·{" "}
        {comparison.service || "Service unknown"}. No firm customer price.
      </p>
      <div className="grid gap-3 xl:grid-cols-2">
        {calculated.suppliers.map((result, index) => {
          const supplier = comparison.suppliers.find(
            (row) => row.id === result.id,
          );
          return (
            <article
              key={result.id}
              className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3"
              aria-label={`Comparison for ${supplier?.supplierName || `supplier ${index + 1}`}`}
            >
              <h4 className="font-medium">
                {supplier?.supplierName || `Supplier ${index + 1}`}
              </h4>
              <p className="mt-1 text-sm font-medium">
                {result.status === "expired"
                  ? "Evidence expired"
                  : result.status === "unknown"
                    ? "Cost information needed"
                    : "Estimated — manager verification required"}
              </p>
              {(supplier?.availability === "unavailable" ||
                supplier?.availability === "backorder") && (
                <p className="mt-1 text-sm font-semibold text-amber-900">
                  {supplier.availability === "unavailable"
                    ? "Unavailable from this supplier"
                    : "Supplier backorder"}{" "}
                  — confirm availability before proceeding.
                </p>
              )}
              <p className="mt-2 text-lg font-semibold">
                {result.deliveredCostCents === null
                  ? `Known subtotal ${formatPricingMoney(result.knownDeliveredCostCents)}`
                  : `Delivered purchase outlay ${formatPricingMoney(result.deliveredCostCents)}`}
              </p>
              <p className="text-sm">
                Buy {result.packsToBuy}{" "}
                {result.packsToBuy === 1 ? "pack" : "packs"} ·{" "}
                {result.purchasedUnits} purchased units · {result.surplusUnits}{" "}
                surplus units
              </p>
              <p className="text-xs text-slate-600">
                Acquisition outlay {formatPricingMoney(result.goodsCostCents)}.
                Whole packs and supplier minimums are included; surplus is not
                treated as a free credit.
              </p>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {supplier?.fees.map((fee) => {
                  const total = result.fees.find((row) => row.id === fee.id);
                  return (
                    <li key={fee.id}>
                      {fee.label}:{" "}
                      {total?.included
                        ? "Included in pack cost"
                        : total?.extendedCostCents == null
                          ? "Unknown"
                          : formatPricingMoney(total.extendedCostCents)}
                    </li>
                  );
                })}
              </ul>
              {result.missing.length > 0 && (
                <p className="mt-2 text-sm text-amber-800">
                  Missing: {result.missing.join(", ")}. This subtotal is not a
                  complete delivered cost.
                </p>
              )}
              {result.status === "expired" && (
                <p className="mt-2 text-sm text-amber-800">
                  Refresh the supplier evidence before comparing this amount
                  with current estimates.
                </p>
              )}
              <p className="mt-2 text-xs">
                Availability: {supplier?.availability ?? "unknown"} · Lead time:{" "}
                {supplier?.leadTimeDays == null
                  ? "unknown"
                  : `${supplier.leadTimeDays} days`}
              </p>
              {supplier?.terms && (
                <p className="mt-1 whitespace-pre-wrap text-xs">
                  {supplier.terms}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
export function PricingProvisionalComparison({
  draft,
  onChange,
  disabled,
}: {
  draft: ProvisionalComparisonDraft | null;
  onChange: (value: ProvisionalComparisonDraft | null) => void;
  disabled: boolean;
}) {
  if (!draft)
    return (
      <Button
        intent="secondary"
        className="mt-4"
        disabled={disabled}
        onClick={() => onChange(newProvisionalComparison())}
      >
        Compare provisional supplier costs
      </Button>
    );
  let comparison: ReturnType<typeof readProvisionalComparison> | null = null,
    error = "";
  try {
    comparison = readProvisionalComparison(draft);
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Check the comparison inputs.";
  }
  const update = (index: number, patch: Partial<SupplierDraft>) =>
    onChange({
      ...draft,
      suppliers: draft.suppliers.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    });
  return (
    <fieldset
      disabled={disabled}
      className="mt-5 min-w-0 space-y-4 rounded-xl border border-slate-200 p-4"
    >
      <legend className="px-1 font-semibold">
        Provisional supplier comparison
      </legend>
      <p className="text-sm text-slate-600">
        Enter costs for the same item and delivery assumptions. Blank charges
        are unknown; use 0 only for a known no-charge item, or mark it included
        in the pack. All figures remain estimates until verified.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <PricingField label="Comparison requested units">
          <input
            className={pricingControl}
            inputMode="numeric"
            value={draft.quantity}
            onChange={(e) => onChange({ ...draft, quantity: e.target.value })}
          />
        </PricingField>
        <PricingField
          label="Comparison delivery area"
          hint="Use an area or postal code, not patient details."
        >
          <input
            className={pricingControl}
            maxLength={200}
            value={draft.destination}
            onChange={(e) =>
              onChange({ ...draft, destination: e.target.value })
            }
          />
        </PricingField>
        <PricingField label="Comparison delivery service">
          <input
            className={pricingControl}
            maxLength={100}
            value={draft.service}
            onChange={(e) => onChange({ ...draft, service: e.target.value })}
          />
        </PricingField>
      </div>
      {draft.suppliers.map((supplier, index) => {
        const label = (name: string) => `Supplier ${index + 1} ${name}`;
        return (
          <fieldset
            key={supplier.id}
            className="min-w-0 space-y-3 border-t border-slate-200 pt-3"
          >
            <legend className="font-medium">Supplier option {index + 1}</legend>
            <div className="grid gap-3 md:grid-cols-3">
              {(
                [
                  ["supplierName", "name"],
                  ["source", "evidence reference"],
                  ["packCost", "purchase pack cost ($)"],
                  ["unitsPerPack", "units per pack"],
                  ["minimumPacks", "minimum packs"],
                ] as const
              ).map(([key, name]) => (
                <PricingField key={key} label={label(name)}>
                  <input
                    className={pricingControl}
                    value={supplier[key]}
                    inputMode={
                      key === "packCost"
                        ? "decimal"
                        : key === "unitsPerPack" || key === "minimumPacks"
                          ? "numeric"
                          : undefined
                    }
                    onChange={(e) => update(index, { [key]: e.target.value })}
                  />
                </PricingField>
              ))}
              <PricingField label={label("evidence valid through (UTC)")}>
                <input
                  className={pricingControl}
                  type="date"
                  value={supplier.expires}
                  onChange={(e) => update(index, { expires: e.target.value })}
                />
              </PricingField>
              <PricingField label={label("availability")}>
                <select
                  className={pricingControl}
                  value={supplier.availability}
                  onChange={(e) =>
                    update(index, {
                      availability: e.target
                        .value as SupplierDraft["availability"],
                    })
                  }
                >
                  {[
                    "unknown",
                    "available",
                    "limited",
                    "backorder",
                    "unavailable",
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </PricingField>
              <PricingField label={label("lead time (days)")}>
                <input
                  className={pricingControl}
                  inputMode="numeric"
                  value={supplier.leadTimeDays}
                  onChange={(e) =>
                    update(index, { leadTimeDays: e.target.value })
                  }
                />
              </PricingField>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {supplier.fees.map((fee, feeIndex) => {
                const change = (
                  patch: Partial<SupplierDraft["fees"][number]>,
                ) =>
                  update(index, {
                    fees: supplier.fees.map((row, i) =>
                      i === feeIndex ? { ...row, ...patch } : row,
                    ),
                  });
                return (
                  <div
                    className="min-w-0 rounded-lg border border-slate-200 p-3"
                    key={fee.id}
                  >
                    <div className="grid gap-2 sm:grid-cols-2">
                      <PricingField label={label(`${fee.label} ($)`)}>
                        <input
                          className={pricingControl}
                          inputMode="decimal"
                          disabled={Boolean(fee.includedIn)}
                          value={fee.amount}
                          onChange={(e) => change({ amount: e.target.value })}
                        />
                      </PricingField>
                      <PricingField label={label(`${fee.label} basis`)}>
                        <select
                          className={pricingControl}
                          disabled={Boolean(fee.includedIn)}
                          value={fee.basis}
                          onChange={(e) =>
                            change({
                              basis: e.target
                                .value as ProvisionalSupplierFee["basis"],
                              count: "1",
                            })
                          }
                        >
                          <option value="order">Per order</option>
                          <option value="parcel">Per parcel</option>
                          <option value="pack">Per purchased pack</option>
                        </select>
                      </PricingField>
                      {fee.basis === "parcel" && !fee.includedIn && (
                        <PricingField
                          label={label(`${fee.label} parcel count`)}
                        >
                          <input
                            className={pricingControl}
                            inputMode="numeric"
                            value={fee.count}
                            onChange={(e) => change({ count: e.target.value })}
                          />
                        </PricingField>
                      )}
                    </div>
                    <label className="mt-2 flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={Boolean(fee.includedIn)}
                        onChange={(e) =>
                          change({
                            includedIn: e.target.checked ? "pack" : undefined,
                          })
                        }
                      />
                      {label(`${fee.label} is included in pack cost`)}
                    </label>
                  </div>
                );
              })}
            </div>
            <PricingField
              label={label("delivery / return terms and suitability notes")}
            >
              <textarea
                className={pricingControl}
                rows={2}
                value={supplier.terms}
                onChange={(e) => update(index, { terms: e.target.value })}
              />
            </PricingField>
            {draft.suppliers.length > 1 && (
              <Button
                intent="ghost"
                onClick={() =>
                  onChange({
                    ...draft,
                    suppliers: draft.suppliers.filter((_, i) => i !== index),
                  })
                }
              >
                Remove supplier {index + 1}
              </Button>
            )}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          intent="secondary"
          disabled={draft.suppliers.length >= 5}
          onClick={() =>
            onChange({
              ...draft,
              suppliers: [...draft.suppliers, supplierDraft()],
            })
          }
        >
          Add supplier option
        </Button>
        <Button intent="ghost" onClick={() => onChange(null)}>
          Remove comparison
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {comparison && (
        <ProvisionalComparisonSummary
          comparison={comparison.input}
          result={comparison.result}
        />
      )}
      <p className="text-sm font-medium">
        No firm customer price can be issued until a manager maps the item to
        the catalog and verifies the supplier offer.
      </p>
    </fieldset>
  );
}
