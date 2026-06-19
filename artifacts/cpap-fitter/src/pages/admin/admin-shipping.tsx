// /admin/shipping — XPS Ship shipping-label console.
//
// The DME's "print labels" worklist. For each paid, ship-method order that
// hasn't shipped yet, staff can rate-shop carriers, then create a label
// with the patient's address merged straight in — no re-keying into XPS
// Webship. On booking, tracking auto-fills on the order (firing the
// existing patient shipping notification) and the label PDF opens for
// printing. Parcel weight pre-fills from per-product presets.
//
// Efficiency tooling: a batch "create labels for selected" action,
// per-product parcel-weight presets (managed inline), an address-validity
// flag on each row, and (when the worker cron is enabled) automatic
// resolution of staged orders so tracking lands without clicking Sync.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Truck,
  Printer,
  RefreshCw,
  Ban,
  Package,
  CircleAlert,
  Boxes,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { AdminModal } from "@/components/admin/AdminModal";
import { useDocumentTitle } from "@/hooks/admin/use-document-title";
import {
  getXpsStatus,
  getXpsQueue,
  getXpsRates,
  createXpsLabel,
  syncXpsLabel,
  voidXpsLabel,
  xpsLabelPdfUrl,
  getSuggestedParcel,
  batchCreateXpsLabels,
  getXpsProductSpecs,
  saveXpsProductSpecs,
  type LabelResult,
  type ProductSpec,
  type XpsQueueOrder,
  type XpsRate,
} from "@/lib/admin/xps-shipping-api";

const statusKey = ["admin", "xps", "status"] as const;
const queueKey = ["admin", "xps", "queue"] as const;
const specsKey = ["admin", "xps", "product-specs"] as const;

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function AdminShippingPage() {
  useDocumentTitle("Admin · Shipping labels");

  const status = useQuery({ queryKey: statusKey, queryFn: getXpsStatus });
  const queue = useQuery({
    queryKey: queueKey,
    queryFn: () => getXpsQueue(50),
  });

  const [activeOrder, setActiveOrder] = useState<XpsQueueOrder | null>(null);

  const configured = status.data?.availability.status === "configured";

  return (
    <div className="admin-root">
      <div className="p-6 space-y-6 max-w-5xl">
        <header>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Truck className="h-6 w-6" /> Shipping labels
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Create XPS shipping labels with each patient's address merged in.
            Tracking auto-fills on the order and the customer is notified.
          </p>
        </header>

        {status.isPending ? (
          <Spinner label="Checking XPS connection…" />
        ) : status.isError ? (
          <ErrorPanel error={status.error} onRetry={() => status.refetch()} />
        ) : !configured ? (
          <Card>
            <div className="p-4">
              <p className="text-sm font-semibold mb-1">
                XPS Ship not configured
              </p>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                Add your XPS API key, customer id, integration id, and a
                ship-from address under{" "}
                <a
                  href="/admin/system/configuration"
                  className="underline decoration-dotted"
                >
                  System Configuration → Shipping labels (XPS Ship)
                </a>
                . Until then, orders can still be shipped by entering tracking
                manually.
              </p>
            </div>
          </Card>
        ) : null}

        {configured && (
          <>
            <QueueCard
              orders={queue.data?.orders ?? []}
              isPending={queue.isPending}
              isError={queue.isError}
              error={queue.error}
              isFetching={queue.isFetching}
              onRefetch={() => queue.refetch()}
              onCreate={(o) => setActiveOrder(o)}
            />
            <ProductSpecsCard />
          </>
        )}

        {activeOrder && (
          <CreateLabelModal
            order={activeOrder}
            onClose={() => setActiveOrder(null)}
          />
        )}
      </div>
    </div>
  );
}

function QueueCard({
  orders,
  isPending,
  isError,
  error,
  isFetching,
  onRefetch,
  onCreate,
}: {
  orders: XpsQueueOrder[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  onRefetch: () => void;
  onCreate: (o: XpsQueueOrder) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchService, setBatchService] = useState("");
  const [batchMsg, setBatchMsg] = useState<string | null>(null);

  const eligible = orders.filter((o) => o.hasAddress && o.addressValid);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) =>
      prev.size === eligible.length
        ? new Set()
        : new Set(eligible.map((o) => o.id)),
    );
  }

  const batchMut = useMutation({
    mutationFn: () =>
      batchCreateXpsLabels({
        orderIds: [...selected],
        shippingService: batchService.trim(),
      }),
    onSuccess: (data) => {
      setBatchMsg(
        `Booked ${data.summary.booked}, staged ${data.summary.staged}, errors ${data.summary.errored}.`,
      );
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: queueKey });
    },
    onError: () => setBatchMsg("Batch failed — check the service code."),
  });

  return (
    <Card>
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Package className="h-4 w-4" /> Awaiting shipment
          </h2>
          <Button
            intent="ghost"
            size="sm"
            onClick={onRefetch}
            isLoading={isFetching}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        {isPending ? (
          <Spinner label="Loading orders…" />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={onRefetch} />
        ) : orders.length === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No paid orders are awaiting a shipping label. 🎉
          </p>
        ) : (
          <>
            {/* Batch bar */}
            <div
              className="flex flex-wrap items-center gap-2 mb-3 p-2 rounded"
              style={{
                background: "#f8fafc",
                border: "1px solid hsl(var(--line-1))",
              }}
            >
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                {selected.size} selected
              </span>
              <input
                type="text"
                value={batchService}
                onChange={(e) => setBatchService(e.target.value)}
                placeholder="Service code (e.g. ups_ground)"
                className="rounded border px-2 py-1 text-xs"
                style={{ minWidth: 200 }}
              />
              <Button
                size="sm"
                disabled={selected.size === 0 || batchService.trim() === ""}
                isLoading={batchMut.isPending}
                onClick={() => {
                  setBatchMsg(null);
                  batchMut.mutate();
                }}
              >
                <Printer className="h-3.5 w-3.5" /> Create labels (
                {selected.size})
              </Button>
              {batchMsg && (
                <span
                  className="text-xs"
                  style={{ color: "hsl(var(--ink-2))" }}
                >
                  {batchMsg}
                </span>
              )}
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-xs uppercase tracking-wider"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th scope="col" className="py-2 w-6">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={
                        eligible.length > 0 && selected.size === eligible.length
                      }
                      onChange={toggleAll}
                    />
                  </th>
                  <th scope="col" className="py-2">
                    Order
                  </th>
                  <th scope="col" className="py-2">
                    Ship to
                  </th>
                  <th scope="col" className="py-2">
                    Total
                  </th>
                  <th scope="col" className="py-2">
                    Status
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const eligibleRow = o.hasAddress && o.addressValid;
                  return (
                    <tr
                      key={o.id}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td className="py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${o.id.slice(0, 8)}`}
                          disabled={!eligibleRow}
                          checked={selected.has(o.id)}
                          onChange={() => toggle(o.id)}
                        />
                      </td>
                      <td className="py-2">
                        <code className="text-xs">{o.id.slice(0, 8)}</code>
                      </td>
                      <td className="py-2">
                        {o.shipTo ?? "—"}
                        {o.hasAddress && !o.addressValid && (
                          <span
                            className="ml-1 inline-flex items-center gap-0.5 text-[10px]"
                            style={{ color: "#b45309" }}
                            title="Address looks incomplete or malformed"
                          >
                            <CircleAlert className="h-3 w-3" /> check address
                          </span>
                        )}
                      </td>
                      <td className="py-2">
                        {formatCents(o.amountTotalCents)}
                      </td>
                      <td className="py-2">
                        {o.labelStatus === "staged" ? (
                          <span style={{ color: "hsl(var(--ink-3))" }}>
                            staged
                          </span>
                        ) : o.labelStatus === "voided" ? (
                          <span style={{ color: "hsl(var(--ink-3))" }}>
                            voided
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          disabled={!o.hasAddress}
                          onClick={() => onCreate(o)}
                        >
                          {o.hasAddress ? "Create label" : "No address"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Card>
  );
}

function CreateLabelModal({
  order,
  onClose,
}: {
  order: XpsQueueOrder;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [weightOz, setWeightOz] = useState("");
  const [lengthIn, setLengthIn] = useState("");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [rates, setRates] = useState<XpsRate[] | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [result, setResult] = useState<LabelResult | null>(null);

  // Pre-fill the parcel from per-product presets when the modal opens.
  const suggested = useQuery({
    queryKey: ["admin", "xps", "suggested", order.id],
    queryFn: () => getSuggestedParcel(order.id),
  });
  useEffect(() => {
    if (suggested.data) {
      setWeightOz(String(suggested.data.weightOz));
      if (suggested.data.lengthIn != null)
        setLengthIn(String(suggested.data.lengthIn));
      if (suggested.data.widthIn != null)
        setWidthIn(String(suggested.data.widthIn));
      if (suggested.data.heightIn != null)
        setHeightIn(String(suggested.data.heightIn));
    }
  }, [suggested.data]);

  function parcel() {
    return {
      weightOz: Number.parseFloat(weightOz) || 0,
      lengthIn: lengthIn ? Number.parseFloat(lengthIn) : null,
      widthIn: widthIn ? Number.parseFloat(widthIn) : null,
      heightIn: heightIn ? Number.parseFloat(heightIn) : null,
    };
  }

  const ratesMut = useMutation({
    mutationFn: () => getXpsRates(order.id, { parcel: parcel() }),
    onSuccess: (data) => {
      setRates(data.rates);
      if (data.rates.length > 0) setSelectedService(data.rates[0].serviceCode);
    },
  });

  const onLabelSuccess = (data: LabelResult) => {
    setResult(data);
    void qc.invalidateQueries({ queryKey: queueKey });
    if (data.status === "booked") {
      window.open(xpsLabelPdfUrl(order.id), "_blank", "noopener");
    }
  };

  const createMut = useMutation({
    mutationFn: () =>
      createXpsLabel(order.id, {
        parcel: parcel(),
        shippingService: selectedService!,
      }),
    onSuccess: onLabelSuccess,
  });

  const syncMut = useMutation({
    mutationFn: () => syncXpsLabel(order.id),
    onSuccess: onLabelSuccess,
  });

  const voidMut = useMutation({
    mutationFn: () => voidXpsLabel(order.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queueKey });
      onClose();
    },
  });

  const weightValid = (Number.parseFloat(weightOz) || 0) > 0;

  return (
    <AdminModal
      title={`Create label · ${order.id.slice(0, 8)}`}
      description={order.shipTo ?? undefined}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* Parcel */}
        <div>
          <p className="text-xs font-semibold mb-1">Parcel weight &amp; size</p>
          {suggested.data && (
            <p
              className="text-[11px] mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {suggested.data.fromPresets
                ? "Pre-filled from product presets."
                : "Estimated — set product presets for exact weights."}
            </p>
          )}
          <div className="grid grid-cols-4 gap-2">
            <label className="text-xs">
              Weight (oz)
              <input
                type="number"
                min="0"
                step="0.1"
                value={weightOz}
                onChange={(e) => setWeightOz(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              L (in)
              <input
                type="number"
                min="0"
                value={lengthIn}
                onChange={(e) => setLengthIn(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              W (in)
              <input
                type="number"
                min="0"
                value={widthIn}
                onChange={(e) => setWidthIn(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              H (in)
              <input
                type="number"
                min="0"
                value={heightIn}
                onChange={(e) => setHeightIn(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
          </div>
          <div className="mt-2">
            <Button
              intent="secondary"
              size="sm"
              disabled={!weightValid}
              isLoading={ratesMut.isPending}
              onClick={() => ratesMut.mutate()}
            >
              Get rates
            </Button>
          </div>
          {ratesMut.isError && (
            <p className="text-xs mt-1" style={{ color: "#991b1b" }}>
              Couldn't fetch rates. Check the weight and try again.
            </p>
          )}
        </div>

        {/* Rates */}
        {rates && rates.length > 0 && (
          <div>
            <p className="text-xs font-semibold mb-1">Choose a service</p>
            <div className="space-y-1 max-h-48 overflow-auto">
              {rates.map((r) => (
                <label
                  key={`${r.carrierCode}-${r.serviceCode}`}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm cursor-pointer"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="service"
                      checked={selectedService === r.serviceCode}
                      onChange={() => setSelectedService(r.serviceCode)}
                    />
                    {r.serviceDescription}
                  </span>
                  <span className="font-semibold">
                    {formatCents(r.totalCents)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        {rates && rates.length === 0 && (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            No rates returned for this parcel.
          </p>
        )}

        {/* Result */}
        {result?.status === "booked" ? (
          <div
            className="rounded border p-3 text-sm"
            style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}
          >
            <p className="font-semibold">Label booked ✓</p>
            <p className="mt-0.5">
              {result.carrier} · {result.trackingNumber}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  window.open(xpsLabelPdfUrl(order.id), "_blank", "noopener")
                }
              >
                <Printer className="h-3.5 w-3.5" /> Print label
              </Button>
              <Button
                intent="ghost"
                size="sm"
                isLoading={voidMut.isPending}
                onClick={() => voidMut.mutate()}
              >
                <Ban className="h-3.5 w-3.5" /> Void
              </Button>
            </div>
          </div>
        ) : result?.status === "staged" ? (
          <div
            className="rounded border p-3 text-sm"
            style={{ background: "#fffbe6", borderColor: "hsl(var(--line-1))" }}
          >
            <p className="font-semibold">Staged in XPS</p>
            <p className="mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
              The order is in XPS but hasn't been booked into a shipment yet.
              Sync to pull the tracking number and label once XPS processes it.
            </p>
            <div className="mt-2">
              <Button
                size="sm"
                isLoading={syncMut.isPending}
                onClick={() => syncMut.mutate()}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Sync now
              </Button>
            </div>
          </div>
        ) : null}

        {/* Primary action */}
        {!result && (
          <div className="flex justify-end gap-2 pt-2">
            <Button intent="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!selectedService}
              isLoading={createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              <Printer className="h-3.5 w-3.5" /> Create &amp; print label
            </Button>
          </div>
        )}
        {createMut.isError && (
          <p className="text-xs" style={{ color: "#991b1b" }}>
            Couldn't create the label. The order may need signed paperwork or a
            valid address.
          </p>
        )}
      </div>
    </AdminModal>
  );
}

function ProductSpecsCard() {
  const qc = useQueryClient();
  const specsQuery = useQuery({
    queryKey: specsKey,
    queryFn: getXpsProductSpecs,
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, ProductSpec>>({});

  // Seed the editable draft from saved specs + unconfigured product ids.
  useEffect(() => {
    if (!specsQuery.data) return;
    const next: Record<string, ProductSpec> = {};
    for (const s of specsQuery.data.specs) next[s.productId] = { ...s };
    for (const id of specsQuery.data.unconfiguredProductIds) {
      if (!next[id]) {
        next[id] = {
          productId: id,
          weightOz: 0,
          lengthIn: null,
          widthIn: null,
          heightIn: null,
          label: null,
        };
      }
    }
    setDraft(next);
  }, [specsQuery.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      saveXpsProductSpecs(Object.values(draft).filter((s) => s.weightOz > 0)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: specsKey }),
  });

  function setField(id: string, patch: Partial<ProductSpec>) {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));
  }

  const rows = Object.values(draft);

  return (
    <Card>
      <div className="p-4">
        <button
          className="flex items-center gap-2 text-sm font-semibold"
          onClick={() => setOpen((v) => !v)}
        >
          <Boxes className="h-4 w-4" /> Parcel weight presets {open ? "▾" : "▸"}
        </button>
        {open && (
          <div className="mt-3">
            <p className="text-xs mb-2" style={{ color: "hsl(var(--ink-3))" }}>
              Set a default weight (oz) and optional dimensions per product.
              Labels and the batch action pre-fill the parcel by summing these
              across an order's items. Products seen on unshipped orders are
              listed so you can fill in any missing weights.
            </p>
            {specsQuery.isPending ? (
              <Spinner label="Loading presets…" />
            ) : specsQuery.isError ? (
              <ErrorPanel
                error={specsQuery.error}
                onRetry={() => specsQuery.refetch()}
              />
            ) : rows.length === 0 ? (
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No products to configure yet.
              </p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="text-left text-xs uppercase tracking-wider"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <th scope="col" className="py-1">
                        Product
                      </th>
                      <th scope="col" className="py-1">
                        Label
                      </th>
                      <th scope="col" className="py-1">
                        Weight (oz)
                      </th>
                      <th scope="col" className="py-1">
                        L
                      </th>
                      <th scope="col" className="py-1">
                        W
                      </th>
                      <th scope="col" className="py-1">
                        H
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr
                        key={s.productId}
                        className="border-t"
                        style={{ borderColor: "hsl(var(--line-1))" }}
                      >
                        <td className="py-1">
                          <code className="text-[11px]">
                            {s.productId.slice(0, 18)}
                          </code>
                        </td>
                        <td className="py-1">
                          <input
                            type="text"
                            value={s.label ?? ""}
                            onChange={(e) =>
                              setField(s.productId, {
                                label: e.target.value || null,
                              })
                            }
                            className="w-28 rounded border px-1 py-0.5 text-xs"
                            placeholder="name"
                          />
                        </td>
                        <td className="py-1">
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={s.weightOz || ""}
                            onChange={(e) =>
                              setField(s.productId, {
                                weightOz:
                                  Number.parseFloat(e.target.value) || 0,
                              })
                            }
                            className="w-20 rounded border px-1 py-0.5 text-xs"
                          />
                        </td>
                        {(["lengthIn", "widthIn", "heightIn"] as const).map(
                          (dim) => (
                            <td key={dim} className="py-1">
                              <input
                                type="number"
                                min="0"
                                value={s[dim] ?? ""}
                                onChange={(e) =>
                                  setField(s.productId, {
                                    [dim]: e.target.value
                                      ? Number.parseFloat(e.target.value)
                                      : null,
                                  })
                                }
                                className="w-14 rounded border px-1 py-0.5 text-xs"
                              />
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    isLoading={saveMut.isPending}
                    onClick={() => saveMut.mutate()}
                  >
                    Save presets
                  </Button>
                  {saveMut.isSuccess && (
                    <span className="text-xs" style={{ color: "#15803d" }}>
                      Saved.
                    </span>
                  )}
                  {saveMut.isError && (
                    <span className="text-xs" style={{ color: "#991b1b" }}>
                      Save failed.
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
