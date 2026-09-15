import { useState } from "react";
import Papa from "papaparse";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingOffers,
  pricingKey,
  savePricingOffer,
  type OfferInput,
  type OfferVersion,
} from "@/lib/admin/pricing-api";
import {
  formatPricingMoney,
  parsePricingMoney,
  pricingExpiry,
  pricingMoneyInput,
} from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingNotice,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";

type CostRow = {
  id: string;
  label: string;
  amount: string;
  category: OfferInput["components"][number]["category"];
  basis: OfferInput["components"][number]["basis"];
  quantity: string;
  includedInId: string;
  status: OfferInput["components"][number]["status"];
  expiresAt: string;
};
const fresh = () => ({
  supplierName: "",
  supplierSku: "",
  sku: "",
  amount: "",
  unitsPerPack: "1",
  minQuantity: "1",
  maxQuantity: "",
  expiry: "",
  source: "",
  status: "estimated" as OfferInput["status"],
  availability: "unknown" as NonNullable<OfferInput["availability"]>,
  leadTime: "",
  returnTerms: "",
  clinicalSuitability: "",
  scopedDelivery: false,
  country: "",
  postalPrefixes: "",
  service: "",
  stock: false,
  dropship: false,
});
function metadata(
  form: Pick<
    ReturnType<typeof fresh>,
    | "availability"
    | "leadTime"
    | "returnTerms"
    | "clinicalSuitability"
    | "scopedDelivery"
    | "country"
    | "postalPrefixes"
    | "service"
    | "stock"
    | "dropship"
  >,
) {
  const leadTimeDays = form.leadTime.trim() ? Number(form.leadTime) : null;
  if (
    !["available", "limited", "backorder", "unavailable", "unknown"].includes(
      form.availability,
    ) ||
    (leadTimeDays !== null &&
      (!/^\d+$/.test(form.leadTime) ||
        !Number.isInteger(leadTimeDays) ||
        leadTimeDays > 365)) ||
    form.returnTerms.trim().length > 2000 ||
    form.clinicalSuitability.trim().length > 2000
  )
    return null;
  let deliveryScope: OfferInput["deliveryScope"] = null;
  if (form.scopedDelivery) {
    const country = form.country.trim().toUpperCase(),
      postalPrefixes = form.postalPrefixes
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
      service = form.service.trim();
    const fulfillmentMethods: Array<"stock" | "dropship"> = [];
    if (form.stock) fulfillmentMethods.push("stock");
    if (form.dropship) fulfillmentMethods.push("dropship");
    if (
      !/^[A-Z]{2}$/.test(country) ||
      !postalPrefixes.length ||
      postalPrefixes.length > 100 ||
      new Set(postalPrefixes).size !== postalPrefixes.length ||
      postalPrefixes.some((prefix) => prefix.length > 20) ||
      !service ||
      service.length > 100 ||
      !fulfillmentMethods.length
    )
      return null;
    deliveryScope = { country, postalPrefixes, service, fulfillmentMethods };
  }
  return {
    availability: form.availability,
    leadTimeDays,
    returnTerms: form.returnTerms.trim(),
    clinicalSuitability: form.clinicalSuitability.trim(),
    deliveryScope,
  };
}
export function PricingOffersPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0),
    [search, setSearch] = useState("");
  const offers = useQuery({
    queryKey: [...pricingKey, "offers", "latest", offset],
    queryFn: () => getPricingOffers(offset, undefined, "latest"),
  });
  const [form, setForm] = useState(fresh),
    [editing, setEditing] = useState<OfferVersion | null>(null),
    [costs, setCosts] = useState<CostRow[]>([]);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [csv, setCsv] = useState(""),
    [preview, setPreview] = useState<OfferInput[]>([]),
    [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<
    Array<{ sku: string; ok: boolean; message: string }>
  >([]);
  const save = useMutation({
    mutationFn: savePricingOffer,
    onError: () => {
      void qc.invalidateQueries({ queryKey: [...pricingKey, "offers"] });
    },
    onSuccess: () => {
      setNotice(
        "Supplier offer saved as a new version. Existing quotes keep their recorded costs.",
      );
      setForm(fresh());
      setCosts([]);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: pricingKey });
    },
  });
  const change = (key: keyof ReturnType<typeof fresh>, value: string) =>
    setForm((old) => ({ ...old, [key]: value }));
  const edit = (offer: OfferVersion) => {
    save.reset();
    setEditing(offer);
    setNotice("");
    setError(null);
    setForm({
      supplierName: offer.supplierName,
      supplierSku: offer.supplierSku,
      sku: offer.sku,
      amount: pricingMoneyInput(offer.unitCostCents),
      unitsPerPack: String(offer.unitsPerPack),
      minQuantity: String(offer.minQuantity),
      maxQuantity: offer.maxQuantity === null ? "" : String(offer.maxQuantity),
      expiry: offer.expiresAt.slice(0, 10),
      source: offer.source,
      status: offer.status,
      availability: offer.availability ?? "unknown",
      leadTime: offer.leadTimeDays == null ? "" : String(offer.leadTimeDays),
      returnTerms: offer.returnTerms ?? "",
      clinicalSuitability: offer.clinicalSuitability ?? "",
      scopedDelivery: !!offer.deliveryScope,
      country: offer.deliveryScope?.country ?? "",
      postalPrefixes: offer.deliveryScope?.postalPrefixes.join(", ") ?? "",
      service: offer.deliveryScope?.service ?? "",
      stock: offer.deliveryScope?.fulfillmentMethods.includes("stock") ?? false,
      dropship:
        offer.deliveryScope?.fulfillmentMethods.includes("dropship") ?? false,
    });
    setCosts(
      offer.components.map((c) => ({
        id: c.id,
        label: c.label,
        amount: pricingMoneyInput(c.amountCents),
        category: c.category,
        basis: c.basis,
        quantity: String(c.quantity),
        includedInId: c.includedInId ?? "",
        status: c.status,
        expiresAt: c.expiresAt ?? "",
      })),
    );
  };
  const submit = () => {
    setError(null);
    setNotice("");
    const expiresAt =
        editing && form.expiry === editing.expiresAt.slice(0, 10)
          ? editing.expiresAt
          : pricingExpiry(form.expiry),
      unitCostCents = form.amount.trim()
        ? parsePricingMoney(form.amount)
        : null;
    const unitsPerPack = Number(form.unitsPerPack),
      minQuantity = Number(form.minQuantity),
      maxQuantity = form.maxQuantity.trim() ? Number(form.maxQuantity) : null;
    if (
      !form.supplierName.trim() ||
      !form.supplierSku.trim() ||
      !form.source.trim() ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(form.sku) ||
      !expiresAt ||
      Date.parse(expiresAt) <= Date.now() ||
      !Number.isInteger(unitsPerPack) ||
      unitsPerPack < 1 ||
      !Number.isInteger(minQuantity) ||
      minQuantity < 1 ||
      (maxQuantity !== null &&
        (!Number.isInteger(maxQuantity) || maxQuantity < minQuantity)) ||
      (form.amount.trim() && unitCostCents === null) ||
      (form.status === "verified" && unitCostCents === null)
    ) {
      setError(
        "Enter the item SKU, supplier, evidence, future expiry, valid pack quantities, and a known cost for verified offers.",
      );
      return;
    }
    if (
      costs.some((c) => !c.id.trim()) ||
      new Set(costs.map((c) => c.id)).size !== costs.length
    ) {
      setError(
        "Every fee needs a unique shared charge code within this offer.",
      );
      return;
    }
    const components: OfferInput["components"] = [];
    for (const cost of costs) {
      const amountCents = cost.amount.trim()
        ? parsePricingMoney(cost.amount)
        : null;
      const quantity = Number(cost.quantity);
      if (
        !cost.label.trim() ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        (cost.amount.trim() && amountCents === null) ||
        (cost.status === "verified" && amountCents === null) ||
        (cost.expiresAt !== "" && !Number.isFinite(Date.parse(cost.expiresAt)))
      ) {
        setError(
          "Each fee needs a label and whole count. Verified fees require an explicit amount, including $0 when confirmed free.",
        );
        return;
      }
      components.push({
        id: cost.id,
        label: cost.label.trim(),
        amountCents,
        category: cost.category,
        basis: cost.basis,
        quantity,
        status: amountCents === null ? "missing" : cost.status,
        ...(cost.expiresAt ? { expiresAt: cost.expiresAt } : {}),
        ...(cost.includedInId ? { includedInId: cost.includedInId } : {}),
      });
    }
    const details = metadata(form);
    if (!canManage || save.isPending) return;
    if (
      !details ||
      (components.some(
        (component) =>
          component.category === "freight" && component.status === "verified",
      ) &&
        !details.deliveryScope)
    ) {
      setError(
        "Record valid availability and whole lead-time days. Verified freight needs an explicit country, postal coverage, service and fulfillment method; other offers may leave delivery scope unknown.",
      );
      return;
    }
    save.mutate({
      ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}),
      supplierName: form.supplierName.trim(),
      supplierSku: form.supplierSku.trim(),
      sku: form.sku,
      currency: "USD",
      unitCostCents,
      unitsPerPack,
      minQuantity,
      maxQuantity,
      status: form.status,
      effectiveFrom:
        editing && Date.parse(editing.effectiveFrom) > Date.now()
          ? editing.effectiveFrom
          : new Date().toISOString(),
      expiresAt,
      source: form.source.trim(),
      components,
      ...details,
    });
  };
  const previewImport = () => {
    setError(null);
    setImportResults([]);
    setPreview([]);
    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: "greedy",
    });
    if (
      parsed.errors.length ||
      !parsed.data.length ||
      parsed.data.length > 100
    ) {
      setError(
        "Paste a valid CSV with 1–100 rows. Review the column headings shown below.",
      );
      return;
    }
    const rows: OfferInput[] = [];
    for (const [index, row] of parsed.data.entries()) {
      const expiresAt = pricingExpiry(row.expires ?? "");
      const cost = parsePricingMoney(row.unit_cost ?? "");
      if (
        !row.sku ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(row.sku) ||
        !row.supplier ||
        !row.supplier_sku ||
        !row.source ||
        cost === null ||
        !expiresAt ||
        Date.parse(expiresAt) <= Date.now()
      ) {
        setError(
          `Row ${index + 2} needs a valid SKU, supplier, supplier SKU, dollar cost, source, and future expiry.`,
        );
        return;
      }
      const methods = (row.fulfillment_methods ?? "")
        .split("|")
        .map((value) => value.trim())
        .filter(Boolean);
      const details = metadata({
        ...fresh(),
        availability: (row.availability?.trim() || "unknown") as NonNullable<
          OfferInput["availability"]
        >,
        leadTime: row.lead_time_days?.trim() ?? "",
        returnTerms: row.return_terms ?? "",
        clinicalSuitability: row.clinical_suitability ?? "",
        scopedDelivery: !!(
          row.country ||
          row.postal_prefixes ||
          row.delivery_service ||
          row.fulfillment_methods
        ),
        country: row.country ?? "",
        postalPrefixes: (row.postal_prefixes ?? "").replaceAll("|", ","),
        service: row.delivery_service ?? "",
        stock: methods.includes("stock"),
        dropship: methods.includes("dropship"),
      });
      if (
        !details ||
        methods.some((method) => method !== "stock" && method !== "dropship")
      ) {
        setError(
          `Row ${index + 2} has invalid supplier metadata or an incomplete delivery scope.`,
        );
        return;
      }
      rows.push({
        supplierName: row.supplier,
        supplierSku: row.supplier_sku,
        sku: row.sku,
        currency: "USD",
        unitCostCents: cost,
        unitsPerPack: 1,
        minQuantity: 1,
        maxQuantity: null,
        status: "estimated",
        effectiveFrom: new Date().toISOString(),
        expiresAt,
        source: row.source,
        components: [],
        ...details,
      });
    }
    setPreview(rows);
  };
  const importRows = async () => {
    const current = captureSessionCacheGuard(qc);
    setImporting(true);
    const outcomes: Array<{ sku: string; ok: boolean; message: string }> = [];
    for (const row of preview) {
      if (!current()) return;
      try {
        await savePricingOffer(row);
        if (!current()) return;
        outcomes.push({
          sku: row.sku,
          ok: true,
          message: "Imported as estimated; verify fees before approval",
        });
      } catch (e) {
        if (!current()) return;
        outcomes.push({
          sku: row.sku,
          ok: false,
          message: e instanceof Error ? e.message : "Import failed",
        });
      }
      setImportResults([...outcomes]);
    }
    if (current()) {
      setImporting(false);
      setPreview([]);
      void qc.invalidateQueries({ queryKey: pricingKey });
    }
  };
  const filtered =
    offers.data?.offers.filter((o) =>
      `${o.sku} ${o.supplierName} ${o.supplierSku}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <div className="space-y-5">
      {notice && <PricingNotice>{notice}</PricingNotice>}
      <PricingSection
        title="Supplier offers"
        description="Compare the same canonical item across suppliers. Costs are in USD per sellable unit; pack size and quantity limits remain explicit."
      >
        <PricingField label="Find an offer on this page">
          <input
            className={pricingControl}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Item SKU or supplier"
          />
        </PricingField>
        {offers.isPending ? (
          <p role="status" className="mt-4">
            Loading supplier offers…
          </p>
        ) : offers.error ? (
          <ErrorPanel
            error={offers.error}
            onRetry={() => void offers.refetch()}
          />
        ) : (
          <div className="mt-4 space-y-3">
            {filtered.length === 0 && (
              <p className="text-sm text-slate-500">
                No matching offers. Add a supplier quote below to start.
              </p>
            )}
            {filtered.map((o) => (
              <article
                key={o.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-4"
              >
                <div>
                  <p className="font-semibold">
                    {o.sku}{" "}
                    <span className="font-normal text-slate-500">
                      · {o.supplierName}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatPricingMoney(o.unitCostCents)} per unit ·{" "}
                    {o.unitsPerPack} per pack · Minimum {o.minQuantity} ·
                    Version {o.version}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {o.source} · Expires {o.expiresAt.slice(0, 10)} ·{" "}
                    {o.components.length} additional fees
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Availability: {o.availability ?? "unknown"} · Lead time:{" "}
                    {o.leadTimeDays == null
                      ? "Unknown"
                      : `${o.leadTimeDays} day(s)`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Delivery:{" "}
                    {o.deliveryScope
                      ? `${o.deliveryScope.country} · Postal prefixes ${o.deliveryScope.postalPrefixes.join(", ")} · ${o.deliveryScope.service} · ${o.deliveryScope.fulfillmentMethods.join(", ")}`
                      : "Scope not verified"}
                  </p>
                  {(o.returnTerms || o.clinicalSuitability) && (
                    <details className="mt-2 text-xs text-slate-600">
                      <summary className="cursor-pointer">
                        Supplier terms and clinical notes
                      </summary>
                      <p className="mt-1">
                        Return terms: {o.returnTerms || "Not recorded"}
                      </p>
                      <p className="mt-1">
                        Clinical suitability:{" "}
                        {o.clinicalSuitability || "Not recorded"}
                      </p>
                    </details>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <PricingStatus
                    state={
                      Date.parse(o.expiresAt) <= Date.now() ? "stale" : o.status
                    }
                  />
                  {canManage && (
                    <Button
                      intent="secondary"
                      size="sm"
                      disabled={save.isPending || offers.isFetching}
                      onClick={() => edit(o)}
                    >
                      Revise offer
                    </Button>
                  )}
                </div>
              </article>
            ))}
            <div className="flex justify-end gap-2">
              <Button
                intent="ghost"
                disabled={offset === 0 || offers.isFetching}
                onClick={() => {
                  setSearch("");
                  setOffset((n) => Math.max(0, n - 100));
                }}
              >
                Previous
              </Button>
              <Button
                intent="ghost"
                disabled={
                  offers.isFetching ||
                  !(offers.data?.hasMore ?? offers.data?.offers.length === 100)
                }
                onClick={() => {
                  setSearch("");
                  setOffset((n) => n + 100);
                }}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </PricingSection>
      {canManage && (
        <PricingSection
          title={
            editing
              ? `Revise ${editing.sku} · new version`
              : "Add a supplier offer"
          }
          description="Record the supplier evidence and all delivery fees. A blank cost is unknown. Use $0 only when the supplier has confirmed no charge."
        >
          <fieldset disabled={save.isPending}>
            <div className="grid gap-4 md:grid-cols-3">
              {(
                [
                  ["sku", "Canonical item SKU"],
                  ["supplierName", "Supplier name"],
                  ["supplierSku", "Supplier item code"],
                  ["amount", "Goods cost per sellable unit ($)"],
                  ["unitsPerPack", "Units per supplier pack"],
                  ["minQuantity", "Minimum units"],
                  ["maxQuantity", "Maximum units (optional)"],
                  ["source", "Quote source / reference"],
                ] as const
              ).map(([key, label]) => (
                <PricingField key={key} label={label}>
                  <input
                    className={pricingControl}
                    value={form[key]}
                    onChange={(e) => change(key, e.target.value)}
                    disabled={key === "sku" && !!editing}
                    inputMode={
                      [
                        "amount",
                        "unitsPerPack",
                        "minQuantity",
                        "maxQuantity",
                      ].includes(key)
                        ? "decimal"
                        : undefined
                    }
                  />
                </PricingField>
              ))}
              <PricingField label="Cost confidence">
                <select
                  className={pricingControl}
                  value={form.status}
                  onChange={(e) => change("status", e.target.value)}
                >
                  <option value="estimated">Estimated — requires review</option>
                  <option value="verified">
                    Verified against supplier evidence
                  </option>
                  <option value="missing">Cost information needed</option>
                  <option value="stale">Stale</option>
                </select>
              </PricingField>
              <PricingField label="Valid through (UTC)">
                <input
                  className={pricingControl}
                  type="date"
                  value={form.expiry}
                  onChange={(e) => change("expiry", e.target.value)}
                />
              </PricingField>
            </div>
            <fieldset className="mt-5 space-y-3 rounded-lg border border-slate-200 p-4">
              <legend className="px-1 text-sm font-semibold">
                Supplier suitability and delivery scope
              </legend>
              <div className="grid gap-3 md:grid-cols-2">
                <PricingField label="Supplier availability">
                  <select
                    className={pricingControl}
                    value={form.availability}
                    onChange={(e) => change("availability", e.target.value)}
                  >
                    {[
                      "available",
                      "limited",
                      "backorder",
                      "unavailable",
                      "unknown",
                    ].map((value) => (
                      <option value={value} key={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </PricingField>
                <PricingField
                  label="Supplier lead time (days)"
                  hint="Leave blank when unknown; zero means confirmed same-day availability."
                >
                  <input
                    className={pricingControl}
                    type="number"
                    min={0}
                    max={365}
                    value={form.leadTime}
                    onChange={(e) => change("leadTime", e.target.value)}
                  />
                </PricingField>
                <PricingField label="Supplier return terms">
                  <textarea
                    className={pricingControl}
                    maxLength={2000}
                    value={form.returnTerms}
                    onChange={(e) => change("returnTerms", e.target.value)}
                    rows={2}
                  />
                </PricingField>
                <PricingField
                  label="Clinical suitability notes"
                  hint="These notes do not replace the patient's prescription or clinical review."
                >
                  <textarea
                    className={pricingControl}
                    maxLength={2000}
                    value={form.clinicalSuitability}
                    onChange={(e) =>
                      change("clinicalSuitability", e.target.value)
                    }
                    rows={2}
                  />
                </PricingField>
              </div>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.scopedDelivery}
                  onChange={(e) =>
                    setForm((old) => ({
                      ...old,
                      scopedDelivery: e.target.checked,
                    }))
                  }
                />
                Delivery fee coverage is documented
              </label>
              <p className="text-xs text-slate-600">
                A verified freight fee covers only the recorded country, postal
                prefixes, service and fulfillment methods. Outside that
                coverage, the order needs a fresh verified estimate.
              </p>
              {form.scopedDelivery && (
                <div className="grid gap-3 md:grid-cols-3">
                  <PricingField
                    label="Delivery country code"
                    hint="Two-letter country code from the supplier quote."
                  >
                    <input
                      className={pricingControl}
                      maxLength={2}
                      value={form.country}
                      onChange={(e) => change("country", e.target.value)}
                    />
                  </PricingField>
                  <PricingField
                    label="Covered postal prefixes"
                    hint="Comma-separated prefixes, for example 190, 191. Record only quoted coverage."
                  >
                    <input
                      className={pricingControl}
                      value={form.postalPrefixes}
                      onChange={(e) => change("postalPrefixes", e.target.value)}
                    />
                  </PricingField>
                  <PricingField label="Quoted delivery service">
                    <input
                      className={pricingControl}
                      maxLength={100}
                      value={form.service}
                      onChange={(e) => change("service", e.target.value)}
                    />
                  </PricingField>
                  <div className="space-y-2 text-sm">
                    <p className="font-medium">Covered fulfillment methods</p>
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={form.stock}
                        onChange={(e) =>
                          setForm((old) => ({
                            ...old,
                            stock: e.target.checked,
                          }))
                        }
                      />
                      Warehouse stock delivery
                    </label>
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={form.dropship}
                        onChange={(e) =>
                          setForm((old) => ({
                            ...old,
                            dropship: e.target.checked,
                          }))
                        }
                      />
                      Supplier dropship delivery
                    </label>
                  </div>
                </div>
              )}
            </fieldset>
            <div className="mt-5 space-y-3">
              <h3 className="text-sm font-semibold">
                Additional supplier and delivery fees
              </h3>
              {costs.map((cost, index) => (
                <div
                  key={index}
                  className="grid gap-3 rounded-lg bg-slate-50 p-3 md:grid-cols-4"
                >
                  <PricingField
                    label={`Fee ${index + 1} shared charge code`}
                    hint="Reuse the same code for the same supplier charge across items."
                  >
                    <input
                      className={pricingControl}
                      value={cost.id}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c, i) =>
                            i === index ? { ...c, id: e.target.value } : c,
                          ),
                        )
                      }
                    />
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} label`}>
                    <input
                      className={pricingControl}
                      value={cost.label}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c) =>
                            c.id === cost.id
                              ? { ...c, label: e.target.value }
                              : c,
                          ),
                        )
                      }
                    />
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} amount ($)`}>
                    <input
                      className={pricingControl}
                      inputMode="decimal"
                      value={cost.amount}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c) =>
                            c.id === cost.id
                              ? { ...c, amount: e.target.value }
                              : c,
                          ),
                        )
                      }
                    />
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} evidence status`}>
                    <select
                      className={pricingControl}
                      value={cost.status}
                      onChange={(event) =>
                        setCosts((old) =>
                          old.map((row) =>
                            row.id === cost.id
                              ? {
                                  ...row,
                                  status: event.target
                                    .value as CostRow["status"],
                                }
                              : row,
                          ),
                        )
                      }
                    >
                      {["estimated", "verified", "missing", "stale"].map(
                        (status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ),
                      )}
                    </select>
                  </PricingField>
                  <PricingField
                    label={`Fee ${index + 1} evidence expires (UTC)`}
                    hint="Blank uses the offer deadline. Changing the offer does not renew a fee's own evidence."
                  >
                    <input
                      className={pricingControl}
                      type="datetime-local"
                      step="0.001"
                      value={
                        cost.expiresAt
                          ? new Date(cost.expiresAt).toISOString().slice(0, -1)
                          : ""
                      }
                      onChange={(event) =>
                        setCosts((old) =>
                          old.map((row) =>
                            row.id === cost.id
                              ? {
                                  ...row,
                                  expiresAt: event.target.value
                                    ? `${event.target.value}Z`
                                    : "",
                                }
                              : row,
                          ),
                        )
                      }
                    />
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} type`}>
                    <select
                      className={pricingControl}
                      value={cost.category}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c) =>
                            c.id === cost.id
                              ? {
                                  ...c,
                                  category: e.target
                                    .value as CostRow["category"],
                                }
                              : c,
                          ),
                        )
                      }
                    >
                      {[
                        "inbound",
                        "dropship",
                        "freight",
                        "handling",
                        "packaging",
                        "other",
                      ].map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} charged per`}>
                    <select
                      className={pricingControl}
                      value={cost.basis}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c) =>
                            c.id === cost.id
                              ? {
                                  ...c,
                                  basis: e.target.value as CostRow["basis"],
                                }
                              : c,
                          ),
                        )
                      }
                    >
                      {["order", "shipment", "parcel", "unit"].map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} count`}>
                    <input
                      className={pricingControl}
                      type="number"
                      min={1}
                      value={cost.quantity}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c) =>
                            c.id === cost.id
                              ? { ...c, quantity: e.target.value }
                              : c,
                          ),
                        )
                      }
                    />
                  </PricingField>
                  <PricingField label={`Fee ${index + 1} already included in`}>
                    <select
                      className={pricingControl}
                      value={cost.includedInId}
                      onChange={(e) =>
                        setCosts((old) =>
                          old.map((c) =>
                            c.id === cost.id
                              ? { ...c, includedInId: e.target.value }
                              : c,
                          ),
                        )
                      }
                    >
                      <option value="">Separate charge</option>
                      <option value="goods">
                        Already included in goods cost
                      </option>
                      {costs
                        .filter((c) => c.id !== cost.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label || "Other fee"}
                          </option>
                        ))}
                    </select>
                  </PricingField>
                  <Button
                    intent="ghost"
                    onClick={() =>
                      setCosts((old) => old.filter((c) => c.id !== cost.id))
                    }
                  >
                    Remove fee {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                intent="secondary"
                onClick={() =>
                  setCosts((old) => [
                    ...old,
                    {
                      id: crypto.randomUUID(),
                      label: "",
                      amount: "",
                      category: "freight",
                      basis: "order",
                      quantity: "1",
                      includedInId: "",
                      status: "estimated",
                      expiresAt: "",
                    },
                  ])
                }
              >
                Add delivery fee
              </Button>
            </div>
            {error && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {error}
              </p>
            )}
            {save.error && (
              <>
                <ErrorPanel error={save.error} onRetry={submit} />
                {editing && (
                  <p className="mt-2 text-sm text-slate-600">
                    Your unsaved edits are preserved. The offer list is
                    refreshing. If another person revised this offer, choose
                    “Revise offer” on its current version above to replace this
                    form before saving again.
                  </p>
                )}
              </>
            )}
            <div className="mt-4 flex gap-3">
              <Button isLoading={save.isPending} onClick={submit}>
                Save supplier offer
              </Button>
              {editing && (
                <Button
                  intent="ghost"
                  onClick={() => {
                    setEditing(null);
                    setForm(fresh());
                    setCosts([]);
                  }}
                >
                  Cancel revision
                </Button>
              )}
            </div>
          </fieldset>
        </PricingSection>
      )}
      {canManage && (
        <PricingSection
          title="Import supplier cost candidates"
          description="Paste up to 100 CSV rows. Each row creates an estimated offer; review pack sizes and delivery fees before verifying it. Successful rows remain saved if another row fails."
        >
          <p className="mb-2 text-xs text-slate-600">
            Columns: sku,supplier,supplier_sku,unit_cost,source,expires
            (YYYY-MM-DD)
          </p>
          <PricingField label="Supplier offers CSV">
            <textarea
              className={pricingControl}
              rows={4}
              value={csv}
              disabled={importing}
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview([]);
                setImportResults([]);
              }}
            />
          </PricingField>
          <p className="mt-2 text-xs text-slate-600">
            Optional columns: availability, lead_time_days, return_terms,
            clinical_suitability, country, postal_prefixes, delivery_service,
            fulfillment_methods. Separate postal prefixes and fulfillment
            methods with | inside their CSV cells. Delivery coverage requires
            all four coverage columns; imports remain estimated until verified.
          </p>
          <div className="mt-3 flex gap-3">
            <Button
              intent="secondary"
              disabled={importing}
              onClick={previewImport}
            >
              Preview import
            </Button>
            {preview.length > 0 && (
              <Button isLoading={importing} onClick={() => void importRows()}>
                Import {preview.length} reviewed rows
              </Button>
            )}
          </div>
          {preview.length > 0 && (
            <ul className="mt-3 text-sm">
              {preview.map((r, i) => (
                <li key={i}>
                  {r.sku} · {r.supplierName} ·{" "}
                  {formatPricingMoney(r.unitCostCents)} · Estimated
                </li>
              ))}
            </ul>
          )}
          {importResults.length > 0 && (
            <ul aria-live="polite" className="mt-3 space-y-1 text-sm">
              {importResults.map((r, i) => (
                <li
                  key={i}
                  className={r.ok ? "text-emerald-800" : "text-red-700"}
                >
                  {r.sku}: {r.message}
                </li>
              ))}
            </ul>
          )}
        </PricingSection>
      )}
    </div>
  );
}
