// /admin/catalog — the product catalog and warehouse stock.
//
// The catalog used to be the Stripe Products list, with on-hand living in
// each product's metadata. Patients are insurance-only now, so both moved
// to Postgres (migration 0516) and this is the surface that manages them.
//
// Two things staff do here, and the page is arranged around them:
//   1. "What's running out?" — the low-stock filter, front and centre.
//   2. "Fix a number" — an adjustment always asks for a reason, because
//      every movement is ledgered and a count you can't explain later is
//      the thing that makes inventory untrustworthy.
//
// Stock is never edited as a free-form field. You record a movement
// (received 12, dispensed 1, counted 8) and the server derives the
// balance — so the number and its history can never disagree.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Plus, Search } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  adjustStock,
  fetchCatalog,
  saveProduct,
  type CatalogProduct,
  type StockReason,
} from "@/lib/admin/catalog-api";

const REASONS: Array<{ value: StockReason; label: string; hint: string }> = [
  {
    value: "receipt",
    label: "Received",
    hint: "Stock arrived from a supplier",
  },
  { value: "return", label: "Returned", hint: "Came back from a patient" },
  {
    value: "count",
    label: "Physical count",
    hint: "A count corrected the number",
  },
  {
    value: "adjustment",
    label: "Adjustment",
    hint: "Damage, loss, anything else",
  },
];

function stockLabel(p: CatalogProduct): string {
  if (p.stockCount === null) return "Not tracked";
  return `${p.stockCount} ${p.unitOfMeasure}${p.stockCount === 1 ? "" : "s"}`;
}

export function AdminCatalogPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<CatalogProduct | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["admin", "catalog", search, category, lowStockOnly] as const,
    queryFn: () =>
      fetchCatalog({
        q: search || undefined,
        category: category || undefined,
        lowStockOnly: lowStockOnly || undefined,
        limit: 200,
      }),
    staleTime: 30_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "catalog"] });
  };

  const lowCount = (query.data?.products ?? []).filter(
    (p) => p.lowStock,
  ).length;

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-catalog-page"
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Boxes className="h-5 w-5" /> Product catalog
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            The SKUs you dispense and how many are on the shelf. Stock moves are
            recorded with a reason, so every count can be explained.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
          onClick={() => setCreating(true)}
          data-testid="catalog-add-product"
        >
          <Plus className="h-4 w-4" /> Add a SKU
        </button>
      </header>

      {lowCount > 0 && !lowStockOnly && (
        <button
          type="button"
          onClick={() => setLowStockOnly(true)}
          className="flex w-full items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-left text-sm text-amber-900 hover:bg-amber-100"
          data-testid="catalog-low-stock-banner"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <strong>
              {lowCount} SKU{lowCount === 1 ? "" : "s"}
            </strong>{" "}
            at or below the reorder point — show only these
          </span>
        </button>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by SKU or name"
              className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-sm"
              data-testid="catalog-search"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            data-testid="catalog-category"
          >
            <option value="">All categories</option>
            {(query.data?.categories ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={lowStockOnly}
              onChange={(e) => setLowStockOnly(e.target.checked)}
              data-testid="catalog-low-only"
            />
            Low stock only
          </label>
        </div>
      </Card>

      {query.isLoading && <Spinner />}
      {query.isError && <ErrorPanel error={query.error} />}

      {query.data && (
        <Card>
          {query.data.products.length === 0 ? (
            <p className="p-6 text-sm text-slate-600">
              {search || category || lowStockOnly
                ? "No SKUs match those filters."
                : "No SKUs yet. Add the supplies you dispense so the app can track what's on the shelf."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2">SKU</th>
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Category</th>
                    <th className="px-4 py-2 text-right">On hand</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {query.data.products.map((p) => (
                    <tr
                      key={p.sku}
                      className="border-b border-slate-100 last:border-0"
                      data-testid={`catalog-row-${p.sku}`}
                    >
                      <td className="px-4 py-2 font-mono text-xs">{p.sku}</td>
                      <td className="px-4 py-2">
                        {p.name}
                        {p.manufacturer && (
                          <span className="text-slate-500">
                            {" "}
                            · {p.manufacturer}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-600">
                        {p.category ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span
                          className={
                            p.lowStock ? "font-semibold text-amber-700" : ""
                          }
                        >
                          {stockLabel(p)}
                        </span>
                        {p.lowStock && (
                          <span
                            className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
                            data-testid={`catalog-low-badge-${p.sku}`}
                          >
                            low
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                          onClick={() => setAdjusting(p)}
                          data-testid={`catalog-adjust-${p.sku}`}
                        >
                          Record movement
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {adjusting && (
        <StockDialog
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            invalidate();
          }}
        />
      )}
      {creating && (
        <NewProductDialog
          categories={query.data?.categories ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/**
 * Record a stock movement. Deliberately NOT a "set the number to X" field:
 * the operator says what happened and by how much, and the server derives
 * the balance. That keeps the ledger and the count in agreement by
 * construction, and it means "why is this 3?" always has an answer.
 */
function StockDialog(props: {
  product: CatalogProduct;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { product } = props;
  const [reason, setReason] = useState<StockReason>("receipt");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const qty = Number.parseInt(amount, 10);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("Enter a whole number greater than zero.");
      }
      // A physical count is an absolute figure, not a movement — convert it
      // to the delta that lands on it, so the ledger still reads as history.
      const delta =
        reason === "count"
          ? qty - (product.stockCount ?? 0)
          : reason === "receipt" || reason === "return"
            ? qty
            : -qty;
      if (delta === 0) {
        throw new Error(
          "That count matches the current number — nothing to record.",
        );
      }
      return adjustStock(product.sku, {
        delta,
        reason,
        note: note.trim() || null,
      });
    },
    onSuccess: props.onSaved,
  });

  const isCount = reason === "count";

  return (
    <Card>
      <form
        className="space-y-4 p-5"
        data-testid="catalog-stock-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <div>
          <h2 className="text-base font-semibold">
            Record a movement — {product.name}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            <span className="font-mono text-xs">{product.sku}</span> ·{" "}
            {stockLabel(product)} on hand
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">What happened</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as StockReason)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              data-testid="stock-reason"
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              {REASONS.find((r) => r.value === reason)?.hint}
            </span>
          </label>

          <label className="text-sm">
            <span className="mb-1 block font-medium">
              {isCount ? "Counted total" : "How many"}
            </span>
            <input
              type="number"
              min={isCount ? 0 : 1}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              data-testid="stock-amount"
              required
            />
            <span className="mt-1 block text-xs text-slate-500">
              {isCount
                ? "The number you actually counted on the shelf."
                : "Units, not the new total."}
            </span>
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Note (optional)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
            data-testid="stock-note"
            placeholder="Damaged in transit, supplier short-shipped, …"
          />
        </label>

        {mutation.isError && (
          <p className="text-sm text-red-700" data-testid="stock-error">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Couldn't record that movement."}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            data-testid="stock-submit"
          >
            {mutation.isPending ? "Recording…" : "Record"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function NewProductDialog(props: {
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [trackStock, setTrackStock] = useState(true);
  const [opening, setOpening] = useState("0");
  const [threshold, setThreshold] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      saveProduct({
        sku: sku.trim(),
        name: name.trim(),
        category: category || null,
        manufacturer: manufacturer.trim() || null,
        // Leaving stock untracked is a real choice, not an omission: a
        // tenant who doesn't count a consumable should never get low-stock
        // warnings about it.
        openingStock: trackStock ? Number.parseInt(opening || "0", 10) : null,
        lowStockThreshold:
          trackStock && threshold ? Number.parseInt(threshold, 10) : null,
      }),
    onSuccess: props.onSaved,
  });

  return (
    <Card>
      <form
        className="space-y-4 p-5"
        data-testid="catalog-new-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <h2 className="text-base font-semibold">Add a SKU</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">SKU</span>
            <input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono"
              data-testid="new-sku"
              required
            />
            <span className="mt-1 block text-xs text-slate-500">
              Your warehouse identifier — the same one PacWare and the claim
              use.
            </span>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              data-testid="new-name"
              required
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              data-testid="new-category"
            >
              <option value="">—</option>
              {props.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Manufacturer</span>
            <input
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              data-testid="new-manufacturer"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={trackStock}
            onChange={(e) => setTrackStock(e.target.checked)}
            data-testid="new-track-stock"
          />
          Track how many of these we have
        </label>

        {trackStock && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">On hand today</span>
              <input
                type="number"
                min={0}
                step={1}
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2"
                data-testid="new-opening"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Reorder at</span>
              <input
                type="number"
                min={0}
                step={1}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder="5"
                className="w-full rounded-md border border-slate-300 px-3 py-2"
                data-testid="new-threshold"
              />
              <span className="mt-1 block text-xs text-slate-500">
                Warn at or below this. Blank uses the default of 5.
              </span>
            </label>
          </div>
        )}

        {mutation.isError && (
          <p className="text-sm text-red-700" data-testid="new-error">
            Couldn&apos;t save that SKU. Check the identifier and try again.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            data-testid="new-submit"
          >
            {mutation.isPending ? "Saving…" : "Add SKU"}
          </button>
        </div>
      </form>
    </Card>
  );
}

export default AdminCatalogPage;
