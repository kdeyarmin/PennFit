import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bulkPatchShopProductStock,
  centsToPriceDraft,
  InventoryUnavailableError,
  listShopInventory,
  parsePriceDraftToCents,
  patchShopProductPrice,
  patchShopProductStock,
  patchShopProductThreshold,
  type BulkStockResultItem,
  type InventoryProductRow,
  type ListShopInventoryResponse,
} from "@/lib/admin/shop-inventory-api";

// Default threshold the storefront falls back to when a SKU has no
// per-SKU `lowStockThreshold` set. Mirrors the constant in
// cpap-fitter/src/lib/shop-api.ts so the badge in this page reflects
// what the customer actually sees.
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

// Shop Inventory admin page.
//
// One-line summary: lists every catalog SKU with its current
// `stock_count` (from Stripe metadata) and price (from the Stripe
// default_price) and lets an admin edit both inline. Saves write
// through to Stripe via PATCH /admin/shop/products/:id/{stock,
// threshold,price}; the public storefront's 60s product cache
// will pick the change up on its next flush.
//
// Why one row per SKU (no pagination):
//   The PennPaps cash-pay catalog is intentionally small (under
//   ~30 SKUs). When/if it grows past a screenful, paginate then.
//   Today's UX is "see the whole list and find the SKU you came
//   to edit" — anything fancier would be premature.
//
// Why optimistic update:
//   The Stripe round-trip is ~600ms in good conditions. Without
//   optimism the row visibly stalls between "Save" click and the
//   row re-render. We snapshot the previous list on mutate and
//   roll back on error.

const QUERY_KEY = ["shop-inventory"] as const;

function StockCell({
  product,
  onSaved,
}: {
  product: InventoryProductRow;
  onSaved: (next: InventoryProductRow) => void;
}) {
  // Local draft state so the input is editable without committing
  // to the server on every keystroke. Empty string is the "untrack"
  // sentinel (matches the `null` server contract).
  const [draft, setDraft] = useState<string>(
    product.stockCount === null ? "" : String(product.stockCount),
  );
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (stockCount: number | null) =>
      patchShopProductStock(product.id, stockCount),
    onMutate: async (stockCount) => {
      // Optimistic update: snapshot prior, write the new value,
      // return the snapshot so onError can roll back.
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const prev =
        queryClient.getQueryData<ListShopInventoryResponse>(QUERY_KEY);
      if (prev) {
        queryClient.setQueryData<ListShopInventoryResponse>(QUERY_KEY, {
          ...prev,
          products: prev.products.map((p) =>
            p.id === product.id ? { ...p, stockCount } : p,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(QUERY_KEY, ctx.prev);
      }
      setError(
        err instanceof InventoryUnavailableError
          ? "Stripe is not configured in this environment — set STRIPE_SECRET_KEY to edit inventory."
          : err instanceof Error
            ? err.message
            : "Save failed",
      );
    },
    onSuccess: (next) => {
      onSaved(next);
      setError(null);
    },
  });

  // Parse the input to the server contract. Empty / dash → null
  // ("untrack"). Anything else must be a non-negative integer.
  function parseDraft():
    | { ok: true; value: number | null }
    | { ok: false; reason: string } {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === "—") return { ok: true, value: null };
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, reason: "Whole number, or blank to untrack." };
    }
    const n = parseInt(trimmed, 10);
    if (n < 0 || n > 1_000_000) {
      return { ok: false, reason: "Must be between 0 and 1,000,000." };
    }
    return { ok: true, value: n };
  }

  function handleSave() {
    const parsed = parseDraft();
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    saveMutation.mutate(parsed.value);
  }

  function handleUntrack() {
    setDraft("");
    setError(null);
    saveMutation.mutate(null);
  }

  const dirty = (() => {
    const trimmed = draft.trim();
    if (trimmed === "" && product.stockCount === null) return false;
    if (trimmed === String(product.stockCount ?? "")) return false;
    return true;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="untracked"
          aria-label={`Stock count for ${product.name}`}
          data-testid={`stock-input-${product.id}`}
          disabled={saveMutation.isPending}
          style={{
            width: 96,
            padding: "6px 8px",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: 14,
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending}
          data-testid={`stock-save-${product.id}`}
          style={{
            padding: "6px 12px",
            background: dirty ? "#0a1f44" : "#e5e7eb",
            color: dirty ? "#ffffff" : "#6b7280",
            border: "none",
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 500,
            cursor:
              dirty && !saveMutation.isPending ? "pointer" : "not-allowed",
          }}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleUntrack}
          disabled={product.stockCount === null || saveMutation.isPending}
          data-testid={`stock-untrack-${product.id}`}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: "hsl(var(--ink-3))",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 500,
            cursor:
              product.stockCount === null || saveMutation.isPending
                ? "not-allowed"
                : "pointer",
          }}
        >
          Untrack
        </button>
      </div>
      {error ? (
        <div
          role="alert"
          style={{ color: "#b91c1c", fontSize: 12, maxWidth: 320 }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

// PriceCell mirrors StockCell (same draft-state + optimistic-save
// pattern) but edits the storefront price. The server rotates the
// Stripe Price objects (new Price + default_price repoint — Stripe
// Prices are immutable) and keeps any Subscribe & Save price in sync,
// so from here it's just "type dollars, save".
function PriceCell({
  product,
  onSaved,
}: {
  product: InventoryProductRow;
  onSaved: (next: InventoryProductRow) => void;
}) {
  const [draft, setDraft] = useState<string>(
    centsToPriceDraft(product.priceCents),
  );
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (unitAmountCents: number) =>
      patchShopProductPrice(product.id, unitAmountCents),
    onMutate: async (unitAmountCents) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const prev =
        queryClient.getQueryData<ListShopInventoryResponse>(QUERY_KEY);
      if (prev) {
        queryClient.setQueryData<ListShopInventoryResponse>(QUERY_KEY, {
          ...prev,
          products: prev.products.map((p) =>
            p.id === product.id ? { ...p, priceCents: unitAmountCents } : p,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QUERY_KEY, ctx.prev);
      setError(
        err instanceof InventoryUnavailableError
          ? "Stripe is not configured in this environment — set STRIPE_SECRET_KEY to edit prices."
          : err instanceof Error
            ? err.message
            : "Save failed",
      );
    },
    onSuccess: (next) => {
      onSaved(next);
      // Normalise the draft to the canonical two-decimal form so a
      // save of "19.9" doesn't leave the row permanently "dirty"
      // against the server's 1990 cents.
      setDraft(centsToPriceDraft(next.priceCents));
      setError(null);
    },
  });

  function handleSave() {
    const parsed = parsePriceDraftToCents(draft);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    saveMutation.mutate(parsed.cents);
  }

  // A row without a projected price can't be repriced from here —
  // defensive only; the catalog projection guarantees a price.
  if (product.priceCents === null) {
    return <span style={{ color: "hsl(var(--ink-3))" }}>—</span>;
  }

  const dirty = draft.trim() !== centsToPriceDraft(product.priceCents);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ color: "hsl(var(--ink-2))", fontSize: 14 }}>$</span>
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Price in dollars for ${product.name}`}
          data-testid={`price-input-${product.id}`}
          disabled={saveMutation.isPending}
          style={{
            width: 96,
            padding: "6px 8px",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: 14,
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending}
          data-testid={`price-save-${product.id}`}
          style={{
            padding: "6px 12px",
            background: dirty ? "#0a1f44" : "#e5e7eb",
            color: dirty ? "#ffffff" : "#6b7280",
            border: "none",
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 500,
            cursor:
              dirty && !saveMutation.isPending ? "pointer" : "not-allowed",
          }}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <div
          role="alert"
          style={{ color: "#b91c1c", fontSize: 12, maxWidth: 320 }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

// StockBadge renders the same colour tier the customer sees on the
// storefront. Honours the per-SKU threshold (A15) — when null, falls
// back to the storefront default. Threshold of 0 means "never show
// the low badge" (admin opt-out for SKUs where the signal isn't
// useful).
function StockBadge({
  count,
  threshold,
}: {
  count: number | null;
  threshold: number | null;
}) {
  if (count === null) {
    return (
      <span style={{ color: "hsl(var(--ink-3))", fontSize: 12 }}>
        Not tracked
      </span>
    );
  }
  if (count === 0) {
    return (
      <span
        style={{
          background: "#fee2e2",
          color: "#991b1b",
          fontSize: 12,
          padding: "2px 8px",
          borderRadius: 999,
          fontWeight: 500,
        }}
      >
        Out of stock
      </span>
    );
  }
  const effective = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  if (effective > 0 && count <= effective) {
    return (
      <span
        style={{
          background: "#fef3c7",
          color: "#92400e",
          fontSize: 12,
          padding: "2px 8px",
          borderRadius: 999,
          fontWeight: 500,
        }}
      >
        Low ({count} left)
      </span>
    );
  }
  return (
    <span style={{ color: "hsl(var(--ink-2))", fontSize: 13 }}>
      {count} in stock
    </span>
  );
}

// ThresholdCell mirrors StockCell exactly (same draft-state +
// optimistic-save pattern) but writes via the threshold endpoint.
// Empty string saves `null`, restoring the storefront default of 5.
function ThresholdCell({
  product,
  onSaved,
}: {
  product: InventoryProductRow;
  onSaved: (next: InventoryProductRow) => void;
}) {
  const [draft, setDraft] = useState<string>(
    product.lowStockThreshold === null ? "" : String(product.lowStockThreshold),
  );
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (lowStockThreshold: number | null) =>
      patchShopProductThreshold(product.id, lowStockThreshold),
    onMutate: async (lowStockThreshold) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const prev =
        queryClient.getQueryData<ListShopInventoryResponse>(QUERY_KEY);
      if (prev) {
        queryClient.setQueryData<ListShopInventoryResponse>(QUERY_KEY, {
          ...prev,
          products: prev.products.map((p) =>
            p.id === product.id ? { ...p, lowStockThreshold } : p,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QUERY_KEY, ctx.prev);
      setError(
        err instanceof InventoryUnavailableError
          ? "Stripe is not configured in this environment."
          : err instanceof Error
            ? err.message
            : "Save failed",
      );
    },
    onSuccess: (next) => {
      onSaved(next);
      setError(null);
    },
  });

  function parseDraft():
    | { ok: true; value: number | null }
    | { ok: false; reason: string } {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === "—") return { ok: true, value: null };
    if (!/^\d+$/.test(trimmed))
      return { ok: false, reason: "Whole number, or blank for default." };
    const n = parseInt(trimmed, 10);
    if (n < 0 || n > 1000)
      return { ok: false, reason: "Must be between 0 and 1000." };
    return { ok: true, value: n };
  }

  function handleSave() {
    const parsed = parseDraft();
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    saveMutation.mutate(parsed.value);
  }

  const dirty = (() => {
    const trimmed = draft.trim();
    if (trimmed === "" && product.lowStockThreshold === null) return false;
    if (trimmed === String(product.lowStockThreshold ?? "")) return false;
    return true;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`default ${DEFAULT_LOW_STOCK_THRESHOLD}`}
          aria-label={`Low-stock threshold for ${product.name}`}
          data-testid={`threshold-input-${product.id}`}
          disabled={saveMutation.isPending}
          style={{
            width: 96,
            padding: "6px 8px",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: 14,
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending}
          data-testid={`threshold-save-${product.id}`}
          style={{
            padding: "6px 12px",
            background: dirty ? "#0a1f44" : "#e5e7eb",
            color: dirty ? "#ffffff" : "#6b7280",
            border: "none",
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 500,
            cursor:
              dirty && !saveMutation.isPending ? "pointer" : "not-allowed",
          }}
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <div role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

// BulkStockBar — sticky toolbar at the top of the inventory list that
// appears when one or more rows are selected. Lets the operator
// type a single stock value and apply it to every selected SKU in
// one shot. Internally fans out parallel PATCHes; per-row failures
// are surfaced inline.
function BulkStockBar({
  selectedIds,
  onClear,
  onApplied,
}: {
  selectedIds: ReadonlySet<string>;
  onClear: () => void;
  onApplied: (results: BulkStockResultItem[]) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const count = selectedIds.size;

  const bulkMutation = useMutation({
    mutationFn: async (
      updates: Array<{ productId: string; stockCount: number | null }>,
    ) => bulkPatchShopProductStock(updates),
    onSuccess: (results) => {
      // Patch the cache from each successful row's product payload
      // so we don't need a refetch round-trip.
      const prev =
        queryClient.getQueryData<ListShopInventoryResponse>(QUERY_KEY);
      if (prev) {
        const map = new Map(
          results
            .filter(
              (
                r,
              ): r is BulkStockResultItem & { product: InventoryProductRow } =>
                Boolean(r.ok && r.product),
            )
            .map((r) => [r.product.id, r.product]),
        );
        queryClient.setQueryData<ListShopInventoryResponse>(QUERY_KEY, {
          ...prev,
          products: prev.products.map((p) => map.get(p.id) ?? p),
        });
      }
      onApplied(results);
      setDraft("");
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setError(
          `${failed.length} of ${results.length} saves failed. First error: ${failed[0]?.error ?? "unknown"}`,
        );
      } else {
        setError(null);
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Bulk save failed");
    },
  });

  function parseDraft():
    | { ok: true; value: number | null }
    | { ok: false; reason: string } {
    const trimmed = draft.trim();
    if (trimmed === "" || trimmed === "—") return { ok: true, value: null };
    if (!/^\d+$/.test(trimmed))
      return { ok: false, reason: "Whole number, or blank to untrack." };
    const n = parseInt(trimmed, 10);
    if (n < 0 || n > 1_000_000)
      return { ok: false, reason: "Must be 0–1,000,000." };
    return { ok: true, value: n };
  }

  function handleApply() {
    const parsed = parseDraft();
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    bulkMutation.mutate(
      Array.from(selectedIds).map((id) => ({
        productId: id,
        stockCount: parsed.value,
      })),
    );
  }

  if (count === 0) return null;

  return (
    <div
      data-testid="inventory-bulk-bar"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        background: "#0a1f44",
        color: "#ffffff",
        padding: "12px 16px",
        borderRadius: 6,
        marginBottom: 12,
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      }}
    >
      <span style={{ fontWeight: 500, fontSize: 14 }}>
        {count} SKU{count === 1 ? "" : "s"} selected
      </span>
      <span style={{ fontSize: 13, opacity: 0.85 }}>Set stock to</span>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="number or blank"
        aria-label="Bulk stock count"
        data-testid="inventory-bulk-input"
        disabled={bulkMutation.isPending}
        style={{
          width: 110,
          padding: "6px 8px",
          border: "1px solid #ffffff33",
          borderRadius: 4,
          fontSize: 14,
          background: "#ffffff",
          color: "hsl(var(--ink-1))",
          fontFamily: "inherit",
        }}
      />
      <button
        type="button"
        onClick={handleApply}
        disabled={bulkMutation.isPending}
        data-testid="inventory-bulk-apply"
        style={{
          padding: "6px 14px",
          background: "#ffffff",
          color: "hsl(var(--ink-1))",
          border: "none",
          borderRadius: 4,
          fontSize: 13,
          fontWeight: 600,
          cursor: bulkMutation.isPending ? "not-allowed" : "pointer",
        }}
      >
        {bulkMutation.isPending ? "Applying…" : `Apply to ${count}`}
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={bulkMutation.isPending}
        data-testid="inventory-bulk-clear"
        style={{
          padding: "6px 10px",
          background: "transparent",
          color: "#ffffff",
          border: "1px solid #ffffff66",
          borderRadius: 4,
          fontSize: 13,
          cursor: bulkMutation.isPending ? "not-allowed" : "pointer",
        }}
      >
        Clear selection
      </button>
      {error ? (
        <div
          role="alert"
          style={{ color: "#fecaca", fontSize: 12, width: "100%" }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function AdminShopInventoryPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listShopInventory,
    staleTime: 30_000,
  });

  // Multi-select state for bulk stock updates (A4). We track ids
  // (not row objects) so a stale row from a re-render doesn't
  // accidentally re-include a deleted SKU.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // Catalog search — narrows the rendered rows by product name, SKU id,
  // or category so a long catalog stays navigable instead of being one
  // scroll-forever table. Selection is reset whenever the query changes
  // so a bulk stock update can never silently touch a row the operator
  // can no longer see.
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProducts = useMemo(() => {
    const all = data?.products ?? [];
    if (!normalizedQuery) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(normalizedQuery) ||
        p.id.toLowerCase().includes(normalizedQuery) ||
        (p.category ?? "").toLowerCase().includes(normalizedQuery),
    );
  }, [data, normalizedQuery]);

  function onQueryChange(next: string) {
    setQuery(next);
    setSelectedIds(new Set());
  }

  const visibleIds = useMemo(
    () => filteredProducts.map((p) => p.id),
    [filteredProducts],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  function toggleRow(id: string, on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelectedIds(() => {
      const next = new Set<string>();
      if (on) for (const id of visibleIds) next.add(id);
      return next;
    });
  }

  return (
    <div style={{ maxWidth: 980 }}>
      <header style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 600,
              color: "hsl(var(--ink-1))",
            }}
          >
            Shop Inventory
          </h1>
          {/* Header actions — wouter <Link> would also work, but
              an <a> with the BASE_URL prefix matches the rest of the
              cross-page navigation in this console and avoids pulling
              wouter into the page-level imports. */}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <a
              href={`${import.meta.env.BASE_URL}admin/shop/inventory/archived`}
              style={{
                color: "hsl(var(--ink-2))",
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 6,
                border: "1px solid #d1d5db",
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              View archived
            </a>
            <a
              href={`${import.meta.env.BASE_URL}admin/shop/inventory/new`}
              style={{
                background: "#0a1f44",
                color: "#fff",
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 6,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              + Add product
            </a>
          </div>
        </div>
        <p
          style={{
            margin: "8px 0 0",
            color: "hsl(var(--ink-2))",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Stock counts are stored in Stripe product metadata. Setting a count to{" "}
          <strong>0</strong> hides the “Add to cart” button on the storefront
          and shows an out-of-stock badge. Leave a SKU untracked to keep the
          storefront treating it as always available. Price edits write through
          to Stripe (the Subscribe &amp; Save price follows automatically) and
          reach the storefront within a minute; existing subscriptions keep the
          price they signed up at.
        </p>
      </header>

      {data?.previewMode ? (
        <div
          role="status"
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
            padding: "12px 16px",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          Preview mode: this environment has no Stripe key, so the catalog below
          is a built-in fixture and saves will fail with a clear error. Set{" "}
          <code>STRIPE_SECRET_KEY</code> to make inventory editable.
        </div>
      ) : null}

      {isLoading ? (
        <div style={{ color: "hsl(var(--ink-3))" }}>Loading…</div>
      ) : isError ? (
        <div role="alert" style={{ color: "#b91c1c" }}>
          {error instanceof Error ? error.message : "Failed to load inventory."}
        </div>
      ) : !data || data.products.length === 0 ? (
        <div style={{ color: "hsl(var(--ink-3))" }}>No products found.</div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <input
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search by product, SKU, or category"
              aria-label="Search inventory"
              data-testid="inventory-search"
              style={{
                flex: "1 1 260px",
                minWidth: 200,
                padding: "8px 12px",
                fontSize: 14,
                border: "1px solid hsl(var(--line-1))",
                borderRadius: 6,
              }}
            />
            <span
              style={{ fontSize: 13, color: "hsl(var(--ink-3))" }}
              data-testid="inventory-count"
            >
              {normalizedQuery
                ? `${filteredProducts.length} of ${data.products.length} SKUs`
                : `${data.products.length} SKUs`}
            </span>
          </div>
          <BulkStockBar
            selectedIds={selectedIds}
            onClear={() => setSelectedIds(new Set())}
            onApplied={() => {
              // Keep selection so the operator can type a new
              // value + re-apply if useful. Common pattern: set a
              // bunch to 10, see what looks low, set them all to
              // 0 to pause sales.
            }}
          />
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                minWidth: 720,
                borderCollapse: "collapse",
                background: "#ffffff",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                  <th
                    style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "hsl(var(--ink-2))",
                      width: 36,
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      data-testid="inventory-select-all"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            !allVisibleSelected && someVisibleSelected;
                      }}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    Product
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    Price
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    Stock
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    Edit stock
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    Low-stock threshold
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      data-testid="inventory-no-matches"
                      style={{
                        padding: "16px 12px",
                        color: "hsl(var(--ink-3))",
                        fontSize: 14,
                      }}
                    >
                      No SKUs match “{query}”.
                    </td>
                  </tr>
                ) : null}
                {filteredProducts.map((p) => {
                  const checked = selectedIds.has(p.id);
                  return (
                    <tr
                      key={p.id}
                      style={{
                        borderTop: "1px solid #e5e7eb",
                        background: checked ? "#f0f9ff" : "transparent",
                      }}
                      data-testid={`inventory-row-${p.id}`}
                    >
                      <td style={{ padding: "12px", verticalAlign: "top" }}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.name}`}
                          data-testid={`inventory-select-${p.id}`}
                          checked={checked}
                          onChange={(e) => toggleRow(p.id, e.target.checked)}
                        />
                      </td>
                      <td style={{ padding: "12px", verticalAlign: "top" }}>
                        <div
                          style={{
                            fontWeight: 500,
                            color: "hsl(var(--ink-1))",
                          }}
                        >
                          {p.name}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "hsl(var(--ink-3))",
                            marginTop: 2,
                          }}
                        >
                          {p.category} · {p.id}
                          {" · "}
                          {/* Name/description/tagline/photo edits live on a
                              dedicated page — only the numeric fields are
                              inline-editable in this grid. */}
                          <a
                            href={`${import.meta.env.BASE_URL}admin/shop/inventory/${encodeURIComponent(p.id)}/edit`}
                            data-testid={`inventory-edit-${p.id}`}
                            style={{ color: "hsl(var(--ink-2))" }}
                          >
                            Edit details
                          </a>
                        </div>
                      </td>
                      <td style={{ padding: "12px", verticalAlign: "top" }}>
                        <PriceCell
                          product={p}
                          onSaved={(next) => {
                            const prev =
                              queryClient.getQueryData<ListShopInventoryResponse>(
                                QUERY_KEY,
                              );
                            if (prev) {
                              queryClient.setQueryData<ListShopInventoryResponse>(
                                QUERY_KEY,
                                {
                                  ...prev,
                                  products: prev.products.map((row) =>
                                    row.id === next.id ? next : row,
                                  ),
                                },
                              );
                            }
                          }}
                        />
                      </td>
                      <td style={{ padding: "12px", verticalAlign: "top" }}>
                        <StockBadge
                          count={p.stockCount}
                          threshold={p.lowStockThreshold}
                        />
                      </td>
                      <td style={{ padding: "12px", verticalAlign: "top" }}>
                        <StockCell
                          product={p}
                          onSaved={(next) => {
                            const prev =
                              queryClient.getQueryData<ListShopInventoryResponse>(
                                QUERY_KEY,
                              );
                            if (prev) {
                              queryClient.setQueryData<ListShopInventoryResponse>(
                                QUERY_KEY,
                                {
                                  ...prev,
                                  products: prev.products.map((row) =>
                                    row.id === next.id ? next : row,
                                  ),
                                },
                              );
                            }
                          }}
                        />
                      </td>
                      <td style={{ padding: "12px", verticalAlign: "top" }}>
                        <ThresholdCell
                          product={p}
                          onSaved={(next) => {
                            const prev =
                              queryClient.getQueryData<ListShopInventoryResponse>(
                                QUERY_KEY,
                              );
                            if (prev) {
                              queryClient.setQueryData<ListShopInventoryResponse>(
                                QUERY_KEY,
                                {
                                  ...prev,
                                  products: prev.products.map((row) =>
                                    row.id === next.id ? next : row,
                                  ),
                                },
                              );
                            }
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
