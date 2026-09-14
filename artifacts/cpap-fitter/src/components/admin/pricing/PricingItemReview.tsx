import { PricingSupplierComparison } from "./PricingSupplierComparison";
import { PricingDiscountHeadroom } from "./PricingDiscountHeadroom";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import { fetchCatalog } from "@/lib/admin/catalog-api";
import { searchPatientsForAttach } from "@/lib/admin/manual-documents-api";
import {
  evaluatePricingScenario,
  getActivePricingPrices,
  getPricingRevenueProfiles,
  getPricingOffers,
  getPricingShippingRates,
  getPricingState,
  recommendPricingScenario,
  savePricingQuote,
  pricingKey,
  type PricingShippingRate,
  type RevenueProfile,
  type Quote,
  type Scenario,
  type ResolvedScenario,
} from "@/lib/admin/pricing-api";
import {
  formatPricingMoney,
  parsePricingMoney,
  parsePricingPercent,
  pricingExpiry,
  pricingMoneyInput,
  pricingQuantity,
} from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingMetric,
  PricingNotice,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";

type ReviewLine = {
  id: string;
  sku: string;
  description: string;
  quantity: string;
  amount: string;
  offerId: string;
  offerVersion: number;
  fulfillmentMethod: "stock" | "dropship";
};
export type InitialReviewLine = {
  description: string;
  quantity: number;
  unitAmountCents: number | null;
  sku?: string;
};
const newLine = (line?: InitialReviewLine): ReviewLine => ({
  id: crypto.randomUUID(),
  sku: line?.sku ?? "",
  description: line?.description ?? "",
  quantity: String(line?.quantity ?? 1),
  amount: line ? pricingMoneyInput(line.unitAmountCents) : "",
  offerId: "",
  offerVersion: 0,
  fulfillmentMethod: "dropship",
});
export function PricingItemReview({
  patientId: fixedPatientId,
  initialLines,
  insuranceOnly = false,
  canVerify = false,
  onAttach,
  onAddToBatch,
}: {
  patientId?: string;
  initialLines?: InitialReviewLine[];
  insuranceOnly?: boolean;
  canVerify?: boolean;
  onAttach?: (quote: Quote) => void;
  onAddToBatch?: (scenario: Scenario) => void;
}) {
  const qc = useQueryClient();
  const version = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = useQuery({
    queryKey: [...pricingKey, "state"],
    queryFn: getPricingState,
  });
  const [lines, setLines] = useState<ReviewLine[]>(() =>
    initialLines?.length ? initialLines.map(newLine) : [newLine()],
  );
  const [mode, setMode] = useState<"insurance" | "self_pay">("insurance"),
    [patientId, setPatientId] = useState(fixedPatientId ?? ""),
    [patientSearch, setPatientSearch] = useState("");
  const patients = useQuery({
    queryKey: [...pricingKey, "patient-search", patientSearch],
    queryFn: () => searchPatientsForAttach(patientSearch),
    enabled: !fixedPatientId && patientSearch.trim().length >= 2,
  });
  const [delivery, setDelivery] = useState({
    country: "US",
    postalCode: "",
    service: "",
  });
  const [verifyCollections, setVerifyCollections] = useState(false);
  const [profile, setProfile] = useState<RevenueProfile | null>(null);
  const profiles = useQuery({
    queryKey: [...pricingKey, "revenue-profiles", patientId],
    queryFn: () => getPricingRevenueProfiles(0, patientId),
    enabled: !!patientId && mode === "insurance",
  });
  const activePrices = useQuery({
    queryKey: [...pricingKey, "active-prices"],
    queryFn: getActivePricingPrices,
  });
  const [collectible, setCollectible] = useState(""),
    [collectionSource, setCollectionSource] = useState(""),
    [shipping, setShipping] = useState(""),
    [discount, setDiscount] = useState("");
  const [feeRate, setFeeRate] = useState(""),
    [feeFixed, setFeeFixed] = useState(""),
    [refund, setRefund] = useState(""),
    [reserve, setReserve] = useState(""),
    [overhead, setOverhead] = useState("");
  const [validUntil, setValidUntil] = useState(() =>
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    ),
    [result, setResult] = useState<ResolvedScenario | null>(null),
    [saved, setSaved] = useState<Quote | null>(null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [parcels, setParcels] = useState([
      {
        weightOz: "",
        lengthIn: "",
        widthIn: "",
        heightIn: "",
      },
    ]),
    [rates, setRates] = useState<PricingShippingRate[]>([]),
    [rate, setRate] = useState<PricingShippingRate | null>(null);
  const change = (action: () => void, resetShipping = false) => {
    version.current++;
    evaluate.reset();
    save.reset();
    recommend.reset();
    setVerifyCollections(false);
    action();
    setResult(null);
    setSaved(null);
    setError(null);
    setNotice("");
    if (resetShipping) {
      setRate(null);
      setRates([]);
      setProfile(null);
    }
  };
  const updateLine = (id: string, patch: Partial<ReviewLine>) =>
    change(
      () =>
        setLines((old) =>
          old.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        ),
      true,
    );
  const evaluate = useMutation({
    mutationFn: async ({ scenario }: { scenario: Scenario; version: number }) =>
      evaluatePricingScenario(scenario),
    onSuccess: (data, variables) => {
      if (variables.version !== version.current) return;
      setResult(data);
      setSaved(null);
    },
    onError: () => {
      setResult(null);
    },
  });
  const save = useMutation({
    mutationFn: async ({
      scenario,
      requestApproval,
    }: {
      scenario: Scenario;
      requestApproval: boolean;
      version: number;
    }) => savePricingQuote({ scenario, requestApproval }),
    onSuccess: (data, variables) => {
      void qc.invalidateQueries({ queryKey: [...pricingKey, "quotes"] });
      if (variables.version !== version.current) return;
      setSaved(data);
      setNotice(
        data.status === "approved"
          ? "Review approved and saved. It can be attached to the matching patient order."
          : data.status === "pending_approval"
            ? "Sent to a pricing manager for review."
            : "Draft saved. Review the cost issues before requesting approval.",
      );
    },
  });
  const shippingRates = useMutation({ mutationFn: getPricingShippingRates });
  const [recommendLine, setRecommendLine] = useState(lines[0]?.id ?? "");
  const recommend = useMutation({
    mutationFn: ({
      scenario,
      lineId,
    }: {
      scenario: Scenario;
      lineId: string;
      version: number;
    }) => recommendPricingScenario(scenario, lineId),
    onSuccess: (data, variables) => {
      if (variables.version !== version.current) return;
      setResult(data);
      if (
        data.recommendation.status === "recommended" &&
        data.recommendation.recommendedUnitPriceCents !== null
      ) {
        version.current++;
        setLines((old) =>
          old.map((line) =>
            line.id === variables.lineId
              ? {
                  ...line,
                  amount: pricingMoneyInput(
                    data.recommendation.recommendedUnitPriceCents,
                  ),
                }
              : line,
          ),
        );
        setSaved(null);
        setResult(null);
        setNotice(
          "Suggested unit amount applied. Evaluate again to verify and save the revised scenario.",
        );
      } else
        setNotice(
          `Price recommendation: ${data.recommendation.status.replaceAll("_", " ")}.`,
        );
    },
  });
  const buildScenario = (): Scenario | null => {
    const expiresAt = pricingExpiry(validUntil);
    if (!expiresAt || Date.parse(expiresAt) <= Date.now()) {
      setError("Choose a future date for this review to expire.");
      return null;
    }
    const output: Scenario["lines"] = [];
    for (const line of lines) {
      const quantity = pricingQuantity(line.quantity, onAttach ? 99 : 10_000),
        unitAmountCents = parsePricingMoney(line.amount);
      if (
        !line.sku ||
        !line.description.trim() ||
        !line.offerId ||
        quantity === null ||
        unitAmountCents === null
      ) {
        setError(
          `Choose a canonical item and supplier offer, then enter a whole quantity from 1 to ${onAttach ? "99" : "10,000"} and a dollar amount for every line.`,
        );
        return null;
      }
      output.push({
        id: line.id,
        sku: line.sku,
        description: line.description.trim(),
        quantity,
        unitAmountCents,
        offerId: line.offerId,
        offerVersion: line.offerVersion,
        fulfillmentMethod: line.fulfillmentMethod,
      });
    }
    if (new Set(output.map((l) => l.sku)).size !== output.length) {
      setError("Combine duplicate items into one line per SKU.");
      return null;
    }
    if (rate && Date.parse(rate.expiresAt) <= Date.now()) {
      setError(
        "The shipping estimate expired. Refresh rates and select a current rate.",
      );
      return null;
    }
    if (
      profile &&
      (Date.parse(profile.expiresAt) <= Date.now() ||
        Date.parse(profile.effectiveFrom) > Date.now())
    ) {
      setError(
        "The verified collection profile is outside its validity period. Choose a current profile.",
      );
      return null;
    }
    const expectedCollectibleCents = collectible.trim()
        ? parsePricingMoney(collectible)
        : null,
      shippingChargedCents = parsePricingMoney(shipping),
      discountCents = discount.trim() ? parsePricingMoney(discount) : 0;
    if (
      (mode === "insurance" &&
        collectible.trim() &&
        expectedCollectibleCents === null) ||
      (mode === "self_pay" &&
        (shippingChargedCents === null || discountCents === null))
    ) {
      setError(
        "Enter dollar amounts with no more than two decimal places. Enter $0 explicitly for free customer shipping.",
      );
      return null;
    }
    if (
      mode === "insurance" &&
      canVerify &&
      verifyCollections &&
      !collectionSource.trim()
    ) {
      setError("Record collection evidence before marking it verified.");
      return null;
    }
    const adjustments: NonNullable<Scenario["adjustments"]> = {};
    for (const [key, value] of [
      ["expectedRefundCents", refund],
      ["riskCostCents", reserve],
      ["overheadCents", overhead],
    ] as const) {
      if (value.trim()) {
        const amount = parsePricingMoney(value);
        if (amount === null) {
          setError(
            "Enter valid dollar amounts for refunds, reserves and overhead.",
          );
          return null;
        }
        adjustments[key] = amount;
      }
    }
    let processing: Scenario["processing"];
    if (feeRate.trim() || feeFixed.trim()) {
      const rateBps = parsePricingPercent(feeRate),
        fixedCents = parsePricingMoney(feeFixed);
      if (rateBps === null || fixedCents === null) {
        setError(
          "When modeling processing fees, enter both the rate and fixed amount, including zero where appropriate.",
        );
        return null;
      }
      processing = {
        rateBps,
        fixedCents,
        basis: mode === "insurance" ? "net_sales" : "customer_total",
      };
    }
    return {
      ...(patientId ? { patientId } : {}),
      ...(delivery.service.trim()
        ? {
            delivery: {
              country: delivery.country.trim().toUpperCase(),
              postalCode: delivery.postalCode.trim(),
              service: delivery.service.trim(),
            },
          }
        : {}),
      ...(mode === "insurance" && profile
        ? {
            revenueProfileId: profile.id,
            revenueProfileVersion: profile.version,
          }
        : {}),
      validUntil: new Date(
        Math.min(
          Date.parse(expiresAt),
          rate ? Date.parse(rate.expiresAt) : Infinity,
          profile ? Date.parse(profile.expiresAt) : Infinity,
        ),
      ).toISOString(),
      lines: output,
      revenue:
        mode === "insurance"
          ? {
              mode,
              expectedCollectibleCents,
              status:
                expectedCollectibleCents === null
                  ? "missing"
                  : canVerify && verifyCollections
                    ? "verified"
                    : "estimated",
              source: collectionSource.trim() || undefined,
              expiresAt,
            }
          : {
              mode,
              shippingChargedCents: shippingChargedCents!,
              discountCents: discountCents!,
            },
      ...(rate ? { shippingQuoteId: rate.shippingQuoteId } : {}),
      ...(processing ? { processing } : {}),
      ...(Object.keys(adjustments).length ? { adjustments } : {}),
    };
  };
  const calculate = () => {
    setError(null);
    setNotice("");
    const scenario = buildScenario();
    if (scenario) evaluate.mutate({ scenario, version: version.current });
  };
  const requestRates = async () => {
    setError(null);
    if (lines.some((line) => !pricingQuantity(line.quantity))) {
      setError(
        "Warehouse shipping estimates support patient order quantities from 1 to 99 per item. Larger internal scenarios need a supplier or freight cost estimate.",
      );
      return;
    }
    const current = captureSessionCacheGuard(qc),
      requestVersion = version.current;
    const values = parcels.map((parcel) => ({
      weightOz: Number(parcel.weightOz),
      lengthIn: Number(parcel.lengthIn),
      widthIn: Number(parcel.widthIn),
      heightIn: Number(parcel.heightIn),
    }));
    if (
      !patientId ||
      lines.some(
        (l) =>
          l.fulfillmentMethod !== "stock" ||
          !l.sku ||
          !pricingQuantity(l.quantity),
      ) ||
      values.some((parcel) =>
        Object.values(parcel).some((v) => !Number.isFinite(v) || v <= 0),
      )
    ) {
      setError(
        "Choose a patient, use stock fulfillment for every item, and enter positive package weight and dimensions.",
      );
      return;
    }
    try {
      const data = await shippingRates.mutateAsync({
        patientId,
        lines: lines.map((l) => ({
          sku: l.sku,
          quantity: pricingQuantity(l.quantity)!,
        })),
        parcels: values,
        residential: true,
      });
      if (current() && mounted.current && requestVersion === version.current) {
        setRates(data.rates);
        setRate(null);
        setResult(null);
        setSaved(null);
      }
    } catch {
      /* Shown below. */
    }
  };
  const attach = () => {
    if (
      !saved ||
      saved.status !== "approved" ||
      saved.boundOrderId ||
      saved.scenario.lines.some(
        (line) => !pricingQuantity(String(line.quantity)),
      ) ||
      saved.scenario.revenue.mode !== "insurance" ||
      !saved.patientId ||
      !(Date.parse(saved.validUntil) > Date.now())
    ) {
      setError(
        "Attach a current approved insurance review linked to this patient, with quantities from 1 to 99 per item.",
      );
      return;
    }
    onAttach?.(saved);
  };
  return (
    <div className="space-y-5">
      <PricingSection
        title="Review an item or order"
        description="Compare supplier costs with expected collections. Changing an item or assumption clears the prior result so an old review cannot be reused."
      >
        {state.error ? (
          <ErrorPanel
            error={state.error}
            onRetry={() => void state.refetch()}
          />
        ) : state.isPending ? (
          <p role="status">Loading pricing rules…</p>
        ) : !state.data.policy ? (
          <PricingNotice>
            No pricing policy is configured. A pricing manager must save and
            publish a policy before this review can be evaluated. Existing
            orders remain unreviewed.
          </PricingNotice>
        ) : null}
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <PricingField label="Scenario">
            <select
              className={pricingControl}
              value={mode}
              disabled={insuranceOnly}
              onChange={(e) =>
                change(() => setMode(e.target.value as typeof mode))
              }
            >
              <option value="insurance">
                Insurance — expected collections
              </option>
              <option value="self_pay">
                Self-pay — internal scenario only
              </option>
            </select>
          </PricingField>
          <PricingField label="Review valid through (UTC)">
            <input
              className={pricingControl}
              type="date"
              value={validUntil}
              onChange={(e) => change(() => setValidUntil(e.target.value))}
            />
          </PricingField>
          {!fixedPatientId && (
            <PricingField
              label="Find patient"
              hint="Select a patient before attaching an insurance review to an order."
            >
              <input
                className={pricingControl}
                value={patientSearch}
                onChange={(e) =>
                  change(() => {
                    setPatientSearch(e.target.value);
                    setPatientId("");
                    setCollectible("");
                    setCollectionSource("");
                  }, true)
                }
                placeholder="Search patient name"
              />
            </PricingField>
          )}
        </div>
        {!fixedPatientId && patientSearch.length >= 2 && !patientId && (
          <div className="mt-2 rounded-lg border border-slate-200 p-2">
            {patients.isFetching ? (
              <p role="status">Finding patients…</p>
            ) : patients.error ? (
              <ErrorPanel
                error={patients.error}
                onRetry={() => void patients.refetch()}
              />
            ) : patients.data?.length === 0 ? (
              <p className="text-sm text-slate-500">No patients found.</p>
            ) : (
              patients.data?.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100"
                  onClick={() =>
                    change(() => {
                      setPatientId(p.id);
                      setCollectible("");
                      setCollectionSource("");
                      setPatientSearch(`${p.firstName} ${p.lastName}`);
                    }, true)
                  }
                >
                  {p.firstName} {p.lastName}
                  {p.pacwareId ? ` · ${p.pacwareId}` : ""}
                </button>
              ))
            )}
          </div>
        )}
        {patientId && (
          <p className="mt-2 text-xs text-emerald-800">
            Patient linked to this review.
          </p>
        )}
        <div className="mt-5 space-y-4">
          {lines.map((line, index) => (
            <LineEditor
              key={line.id}
              line={line}
              index={index}
              maximumQuantity={onAttach ? 99 : 10_000}
              onChange={(patch) => updateLine(line.id, patch)}
              onRemove={() =>
                change(
                  () => setLines((old) => old.filter((l) => l.id !== line.id)),
                  true,
                )
              }
              canRemove={lines.length > 1}
            />
          ))}
          <Button
            intent="secondary"
            disabled={lines.length >= 20}
            onClick={() =>
              change(() => setLines((old) => [...old, newLine()]), true)
            }
          >
            Add item
          </Button>
          <p className="text-xs text-slate-600">
            {onAttach
              ? "Patient orders support 1–99 units per item. Use the internal calculator for larger volume simulations."
              : "Internal simulations support 1–10,000 units per item. Scenarios above 99 units per item cannot be attached to a patient order."}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            intent="secondary"
            disabled={!activePrices.data?.batch}
            onClick={() => {
              const entries = activePrices.data!.batch!.entries.filter(
                (e) => e.scenario.revenue.mode === mode,
              );
              const signature = (values: { sku: string; quantity: number }[]) =>
                values
                  .map((l) => `${l.sku}:${l.quantity}`)
                  .sort()
                  .join("|");
              const current = lines.map((l) => ({
                sku: l.sku,
                quantity: Number(l.quantity),
              }));
              const bundle = entries.find(
                (e) => signature(e.scenario.lines) === signature(current),
              );
              const candidates =
                bundle?.scenario.lines ??
                lines.map(
                  (l) =>
                    entries.find(
                      (e) =>
                        e.scenario.lines.length === 1 &&
                        e.scenario.lines[0].sku === l.sku &&
                        e.scenario.lines[0].quantity === Number(l.quantity),
                    )?.scenario.lines[0],
                );
              if (candidates.some((l) => !l)) {
                setError(
                  "No active price entry matches every selected item and quantity.",
                );
                return;
              }
              change(() =>
                setLines((old) =>
                  old.map((l) => ({
                    ...l,
                    amount: pricingMoneyInput(
                      candidates.find((p) => p?.sku === l.sku)!.unitAmountCents,
                    ),
                  })),
                ),
              );
              setNotice(
                `Applied active price list: ${activePrices.data!.batch!.name}. Evaluate the updated scenario before saving.`,
              );
            }}
          >
            Apply active prices
          </Button>
          {activePrices.error && (
            <ErrorPanel
              error={activePrices.error}
              onRetry={() => void activePrices.refetch()}
            />
          )}
        </div>
        {mode === "insurance" && patientId && (
          <div className="mt-4">
            <PricingField
              label="Verified collection profile"
              hint="Only profiles matching this patient, items and quantities are available."
            >
              <select
                className={pricingControl}
                value={profile?.id ?? ""}
                onChange={(e) => {
                  const selected =
                    profiles.data?.profiles.find(
                      (p) => p.id === e.target.value,
                    ) ?? null;
                  change(() => {
                    setProfile(selected);
                    if (selected) {
                      setCollectible(
                        pricingMoneyInput(selected.expectedCollectibleCents),
                      );
                      setCollectionSource(selected.source);
                    }
                  });
                }}
              >
                <option value="">Use a new collection estimate</option>
                {profiles.data?.profiles
                  .filter(
                    (p) =>
                      p.lines.length === lines.length &&
                      p.lines.every((pl) =>
                        lines.some(
                          (l) =>
                            l.sku === pl.sku &&
                            Number(l.quantity) === pl.quantity,
                        ),
                      ),
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ·{" "}
                      {formatPricingMoney(p.expectedCollectibleCents)} · v
                      {p.version}
                    </option>
                  ))}
              </select>
            </PricingField>
            {profiles.error && (
              <ErrorPanel
                error={profiles.error}
                onRetry={() => void profiles.refetch()}
              />
            )}
          </div>
        )}
        {lines.some((l) => l.fulfillmentMethod === "dropship") && (
          <div className="mt-4 rounded border border-slate-200 p-3">
            <p className="mb-3 text-sm font-semibold">
              Supplier delivery destination and service
            </p>
            <p className="mb-3 text-xs text-slate-500">
              Patient reviews use the saved patient address. General item
              scenarios need a destination to check the supplier's delivery
              terms.
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <PricingField label="Delivery country">
                <input
                  className={pricingControl}
                  value={delivery.country}
                  onChange={(e) =>
                    change(() =>
                      setDelivery((old) => ({
                        ...old,
                        country: e.target.value,
                      })),
                    )
                  }
                />
              </PricingField>
              {!patientId && (
                <PricingField label="Delivery postal code">
                  <input
                    className={pricingControl}
                    value={delivery.postalCode}
                    onChange={(e) =>
                      change(() =>
                        setDelivery((old) => ({
                          ...old,
                          postalCode: e.target.value,
                        })),
                      )
                    }
                  />
                </PricingField>
              )}
              <PricingField label="Supplier delivery service">
                <input
                  className={pricingControl}
                  value={delivery.service}
                  onChange={(e) =>
                    change(() =>
                      setDelivery((old) => ({
                        ...old,
                        service: e.target.value,
                      })),
                    )
                  }
                  placeholder="Service named in the supplier quote"
                />
              </PricingField>
            </div>
          </div>
        )}
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {mode === "insurance" ? (
            <>
              <PricingField
                label="Expected total collections ($)"
                hint="Insurance plus expected patient collections, counted once. Blank means unknown."
              >
                <input
                  className={pricingControl}
                  disabled={!!profile}
                  inputMode="decimal"
                  value={collectible}
                  onChange={(e) => change(() => setCollectible(e.target.value))}
                />
              </PricingField>
              <PricingField
                label="Collection evidence / payer reference"
                hint="An estimate requires manager verification before approval."
              >
                <input
                  className={pricingControl}
                  disabled={!!profile}
                  value={collectionSource}
                  onChange={(e) =>
                    change(() => setCollectionSource(e.target.value))
                  }
                />
              </PricingField>
            </>
          ) : (
            <>
              <PricingField label="Shipping charged to customer ($)">
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={shipping}
                  onChange={(e) => change(() => setShipping(e.target.value))}
                />
              </PricingField>
              <PricingField label="Merchandise discount ($)">
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={discount}
                  onChange={(e) => change(() => setDiscount(e.target.value))}
                />
              </PricingField>
              <p className="text-xs text-slate-500 md:col-span-2">
                This is an internal self-pay scenario. It does not collect
                payment, establish insurance patient liability, or calculate
                jurisdictional tax.
              </p>
            </>
          )}
        </div>
        <details className="mt-5 rounded-lg border border-slate-200 p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Optional variable costs and reserves
          </summary>
          <p className="mt-2 text-xs text-slate-500">
            Only add costs that apply. An omitted optional adjustment is
            excluded from this scenario; supplier costs remain required.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {[
              ["Processing rate (%)", feeRate, setFeeRate],
              ["Processing fixed fee ($)", feeFixed, setFeeFixed],
              ["Expected refunds ($)", refund, setRefund],
              ["Risk reserve ($)", reserve, setReserve],
              ["Allocated overhead ($)", overhead, setOverhead],
            ].map(([label, value, setter]) => (
              <PricingField key={label as string} label={label as string}>
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={value as string}
                  onChange={(e) =>
                    change(() =>
                      (setter as (v: string) => void)(e.target.value),
                    )
                  }
                />
              </PricingField>
            ))}
          </div>
        </details>
        {lines.every((l) => l.fulfillmentMethod === "stock") && (
          <details className="mt-4 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Get a warehouse shipping estimate
            </summary>
            <p className="mt-2 text-xs text-slate-500">
              Uses the patient's saved address and configured warehouse origin.
              This does not purchase a label. Supplier dropship quotes use the
              supplier's own delivery fees.
            </p>
            {parcels.map((parcel, index) => (
              <div
                key={index}
                className="mt-3 rounded border border-slate-200 p-3"
              >
                <p className="mb-2 text-xs font-semibold">Parcel {index + 1}</p>
                <div className="grid gap-3 md:grid-cols-4">
                  {(
                    ["weightOz", "lengthIn", "widthIn", "heightIn"] as const
                  ).map((key) => (
                    <PricingField
                      key={key}
                      label={`${index === 0 ? "" : `Parcel ${index + 1} `}${{ weightOz: "Weight (oz)", lengthIn: "Length (in)", widthIn: "Width (in)", heightIn: "Height (in)" }[key]}`}
                    >
                      <input
                        className={pricingControl}
                        inputMode="decimal"
                        value={parcel[key]}
                        onChange={(e) =>
                          change(
                            () =>
                              setParcels((old) =>
                                old.map((p, i) =>
                                  i === index
                                    ? { ...p, [key]: e.target.value }
                                    : p,
                                ),
                              ),
                            true,
                          )
                        }
                      />
                    </PricingField>
                  ))}
                </div>
                {parcels.length > 1 && (
                  <Button
                    intent="ghost"
                    size="sm"
                    onClick={() =>
                      change(
                        () =>
                          setParcels((old) =>
                            old.filter((_, i) => i !== index),
                          ),
                        true,
                      )
                    }
                  >
                    Remove parcel {index + 1}
                  </Button>
                )}
              </div>
            ))}
            <Button
              className="mt-3 mr-3"
              intent="secondary"
              disabled={parcels.length >= 10}
              onClick={() =>
                change(
                  () =>
                    setParcels((old) => [
                      ...old,
                      { weightOz: "", lengthIn: "", widthIn: "", heightIn: "" },
                    ]),
                  true,
                )
              }
            >
              Add parcel
            </Button>
            <Button
              intent="secondary"
              className="mt-3"
              isLoading={shippingRates.isPending}
              onClick={() => void requestRates()}
            >
              Get shipping rates
            </Button>
            {shippingRates.error && (
              <ErrorPanel
                error={shippingRates.error}
                onRetry={() => void requestRates()}
              />
            )}
            <div className="mt-3 space-y-2">
              {rates.map((r) => (
                <label
                  key={r.shippingQuoteId}
                  className="flex gap-2 rounded border border-slate-200 p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="pricing-shipping-rate"
                    checked={rate?.shippingQuoteId === r.shippingQuoteId}
                    onChange={() => change(() => setRate(r))}
                  />
                  <span>
                    {r.carrierCode} · {r.serviceDescription} ·{" "}
                    {formatPricingMoney(r.totalCents)}
                    <span className="block text-xs text-slate-500">
                      Estimate and any review using it expire{" "}
                      {new Date(r.expiresAt).toLocaleString()}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </details>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-700">
            {error}
          </p>
        )}
        {evaluate.error && (
          <ErrorPanel error={evaluate.error} onRetry={calculate} />
        )}
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <Button
            isLoading={evaluate.isPending}
            disabled={!state.data?.policy || recommend.isPending}
            onClick={calculate}
          >
            Evaluate profitability
          </Button>
          {mode === "self_pay" && (
            <>
              <PricingField label="Item to reprice">
                <select
                  className={pricingControl}
                  value={recommendLine}
                  onChange={(e) => setRecommendLine(e.target.value)}
                >
                  {lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.description || "Unnamed item"}
                    </option>
                  ))}
                </select>
              </PricingField>
              <Button
                intent="secondary"
                disabled={!state.data?.policy || evaluate.isPending}
                isLoading={recommend.isPending}
                onClick={() => {
                  const scenario = buildScenario();
                  if (scenario)
                    recommend.mutate({
                      scenario,
                      lineId: recommendLine,
                      version: version.current,
                    });
                }}
              >
                Find unit amount that meets target
              </Button>
            </>
          )}
        </div>
        {recommend.error && (
          <ErrorPanel
            error={recommend.error}
            onRetry={() => recommend.reset()}
          />
        )}
        {mode === "insurance" && canVerify && (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={verifyCollections}
              onChange={(e) =>
                change(() => setVerifyCollections(e.target.checked))
              }
            />
            <span>
              I verified the expected collection amount against the recorded
              evidence.
            </span>
          </label>
        )}
      </PricingSection>
      {result && (
        <PricingSection
          title="Profitability result"
          description="The saved result records the supplier, cost version, policy and expiry used for this review."
          action={<PricingStatus state={result.evaluation.state} />}
        >
          <PricingEvaluationResult result={result} />
          <PricingDiscountHeadroom
            key={`headroom:${JSON.stringify(result.scenario)}`}
            scenario={result.scenario}
          />
          <PricingSupplierComparison
            key={`suppliers:${JSON.stringify(result.scenario)}`}
            scenario={result.scenario}
            onChoose={(lineId, offer) =>
              updateLine(lineId, {
                offerId: offer.id,
                offerVersion: offer.version,
              })
            }
          />
          <div className="mt-5 flex flex-wrap gap-3">
            <Button
              isLoading={save.isPending}
              onClick={() =>
                save.mutate({
                  scenario: result.scenario,
                  requestApproval:
                    result.evaluation.state === "approval_needed",
                  version: version.current,
                })
              }
            >
              {result.evaluation.state === "meets_target"
                ? "Save review"
                : result.evaluation.state === "approval_needed"
                  ? "Request manager approval"
                  : "Save draft review"}
            </Button>
            {onAddToBatch && (
              <Button
                disabled={!!result.scenario.patientId}
                title={
                  result.scenario.patientId
                    ? "Price lists use general item scenarios without a linked patient."
                    : undefined
                }
                intent="secondary"
                onClick={() => {
                  onAddToBatch(result.scenario);
                  setNotice("Scenario added to the bulk preview selection.");
                }}
              >
                Add to bulk preview
              </Button>
            )}
          </div>
          {save.error && (
            <ErrorPanel error={save.error} onRetry={() => save.reset()} />
          )}
        </PricingSection>
      )}
      {notice && <PricingNotice>{notice}</PricingNotice>}
      {saved && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <div>
            <p className="text-sm font-semibold">
              Saved review · revision {saved.revision}
            </p>
            <PricingStatus state={saved.status} />
          </div>
          {onAttach && (
            <Button
              disabled={
                saved.status !== "approved" ||
                saved.scenario.revenue.mode !== "insurance" ||
                !saved.patientId ||
                saved.scenario.lines.some(
                  (line) => !pricingQuantity(String(line.quantity)),
                )
              }
              onClick={attach}
            >
              Use approved review in order
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
function LineEditor({
  line,
  index,
  maximumQuantity,
  onChange,
  onRemove,
  canRemove,
}: {
  line: ReviewLine;
  index: number;
  maximumQuantity: number;
  onChange: (patch: Partial<ReviewLine>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [search, setSearch] = useState(line.sku);
  const products = useQuery({
    queryKey: [...pricingKey, "catalog", search],
    queryFn: () => fetchCatalog({ q: search, limit: 20, offset: 0 }),
    enabled: search.trim().length >= 2,
  });
  const offers = useQuery({
    queryKey: [...pricingKey, "offers-for-sku", line.sku],
    queryFn: () => getPricingOffers(0, line.sku),
    enabled: !!line.sku,
  });
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Item {index + 1}</h3>
        {canRemove && (
          <Button intent="ghost" size="sm" onClick={onRemove}>
            Remove item {index + 1}
          </Button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <PricingField label={`Item ${index + 1} search`}>
          <input
            className={pricingControl}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              onChange({ sku: "", offerId: "", offerVersion: 0 });
            }}
            placeholder="Search name or SKU"
          />
        </PricingField>
        <PricingField label={`Item ${index + 1} catalog choice`}>
          <select
            className={pricingControl}
            value={line.sku}
            onChange={(e) => {
              const product = products.data?.products.find(
                (p) => p.sku === e.target.value,
              );
              onChange({
                sku: e.target.value,
                description: product?.name ?? line.description,
                offerId: "",
                offerVersion: 0,
              });
            }}
          >
            <option value="">Choose a catalog item</option>
            {line.sku &&
              !products.data?.products.some((p) => p.sku === line.sku) && (
                <option value={line.sku}>{line.sku}</option>
              )}
            {products.data?.products.map((p) => (
              <option value={p.sku} key={p.sku}>
                {p.name} · {p.sku}
              </option>
            ))}
          </select>
        </PricingField>
        <PricingField label={`Item ${index + 1} supplier offer`}>
          <select
            className={pricingControl}
            value={line.offerId}
            disabled={!line.sku || offers.isFetching}
            onChange={(e) => {
              const offer = offers.data?.offers.find(
                (o) => o.id === e.target.value,
              );
              onChange({
                offerId: offer?.id ?? "",
                offerVersion: offer?.version ?? 0,
              });
            }}
          >
            <option value="">Choose supplier and cost</option>
            {offers.data?.offers
              .filter((o) => o.sku === line.sku)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.supplierName} · {formatPricingMoney(o.unitCostCents)} ·{" "}
                  {o.status} · v{o.version}
                </option>
              ))}
          </select>
        </PricingField>
        <PricingField label={`Item ${index + 1} description`}>
          <input
            className={pricingControl}
            value={line.description}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </PricingField>
        <PricingField label={`Item ${index + 1} quantity`}>
          <input
            className={pricingControl}
            type="number"
            min={1}
            max={maximumQuantity}
            value={line.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </PricingField>
        <PricingField
          label={`Item ${index + 1} billed / scenario unit amount ($)`}
        >
          <input
            className={pricingControl}
            inputMode="decimal"
            value={line.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
          />
        </PricingField>
        <PricingField label={`Item ${index + 1} fulfillment`}>
          <select
            className={pricingControl}
            value={line.fulfillmentMethod}
            onChange={(e) =>
              onChange({
                fulfillmentMethod: e.target
                  .value as ReviewLine["fulfillmentMethod"],
              })
            }
          >
            <option value="dropship">Supplier dropship</option>
            <option value="stock">Warehouse stock</option>
          </select>
        </PricingField>
      </div>
      {products.error && (
        <ErrorPanel
          error={products.error}
          onRetry={() => void products.refetch()}
        />
      )}{" "}
      {offers.error && (
        <ErrorPanel
          error={offers.error}
          onRetry={() => void offers.refetch()}
        />
      )}{" "}
      {line.sku && !offers.isFetching && offers.data?.offers.length === 0 && (
        <p className="mt-2 text-sm text-amber-800">
          No supplier offer for this item. Ask a pricing manager to add its
          costs, or submit a sourcing proposal.
        </p>
      )}
    </div>
  );
}
export function PricingEvaluationResult({
  result,
}: {
  result: ResolvedScenario;
}) {
  const e = result.evaluation;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PricingMetric
          label={
            e.revenueMode === "insurance"
              ? "Expected collections"
              : "Net revenue"
          }
          value={formatPricingMoney(e.netRevenueCents)}
          detail={
            e.revenueMode === "insurance"
              ? "Billed charges are not expected revenue"
              : "Excludes pass-through tax"
          }
        />
        <PricingMetric
          label="Delivered cost"
          value={formatPricingMoney(e.deliveredCostCents)}
          detail="Goods plus additional fulfillment costs"
        />
        <PricingMetric
          label="Profit after variable costs"
          value={formatPricingMoney(e.contributionCents)}
        />
        <PricingMetric
          label="Policy margin"
          value={
            e.selectedBasisMarginBps === null
              ? "Not available"
              : `${(e.selectedBasisMarginBps / 100).toFixed(2)}%`
          }
          detail={
            e.selectedBasis === "after_overhead"
              ? "Includes allocated overhead"
              : "After variable costs"
          }
        />
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {[
          ["Goods cost", e.goodsCostCents],
          ["Additional delivery costs", e.additionalFulfillmentCostCents],
          ["Processing fees", e.processingFeeCents],
          ["Expected refunds", e.expectedRefundCents],
          ["Risk reserve", e.riskCostCents],
          ["Allocated overhead", e.overheadCents],
          ["Maximum delivered cost at target", e.maximumDeliveredCostCents],
          ...(e.revenueMode === "self_pay"
            ? [
                [
                  "Customer total before any unmodeled tax",
                  e.customerTotalCents,
                ],
              ]
            : []),
        ].map(([label, value]) => (
          <div
            key={label as string}
            className="flex justify-between gap-3 border-b border-slate-100 py-1"
          >
            <dt className="text-slate-600">{label}</dt>
            <dd className="font-medium tabular-nums">
              {formatPricingMoney(value as number | null)}
            </dd>
          </div>
        ))}
      </dl>
      {e.issues.length > 0 && (
        <ul className="list-disc space-y-1 rounded-lg bg-amber-50 p-4 pl-8 text-sm text-amber-900">
          {e.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>{issue.message}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">
        Policy version {result.policyVersion} · {result.dependencies.length}{" "}
        recorded supplier dependencies · Evaluated{" "}
        {new Date(result.input.evaluatedAt).toLocaleString()}
      </p>
    </div>
  );
}
