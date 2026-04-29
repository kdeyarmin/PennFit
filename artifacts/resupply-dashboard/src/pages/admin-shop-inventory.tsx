import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  InventoryUnavailableError,
  listShopInventory,
  patchShopProductStock,
  type InventoryProductRow,
  type ListShopInventoryResponse,
} from "../lib/shop-inventory-api";

// Shop Inventory admin page.
//
// One-line summary: lists every catalog SKU with its current
// `stock_count` (from Stripe metadata) and lets an admin edit it
// inline. Saves write through to Stripe via PATCH /admin/shop/
// products/:id/stock; the public storefront's 60s product cache
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

function formatPrice(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const amount = cents / 100;
  const curr = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: curr,
    }).format(amount);
  } catch {
    return `${curr} ${amount.toFixed(2)}`;
  }
}

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
      const prev = queryClient.getQueryData<ListShopInventoryResponse>(QUERY_KEY);
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
            cursor: dirty && !saveMutation.isPending ? "pointer" : "not-allowed",
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
            color: "#6b7280",
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

function StockBadge({ count }: { count: number | null }) {
  if (count === null) {
    return (
      <span style={{ color: "#6b7280", fontSize: 12 }}>Not tracked</span>
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
  if (count <= 5) {
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
    <span style={{ color: "#374151", fontSize: 13 }}>{count} in stock</span>
  );
}

export function AdminShopInventoryPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listShopInventory,
    staleTime: 30_000,
  });

  return (
    <div style={{ maxWidth: 980 }}>
      <header style={{ marginBottom: 24 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "#0a1f44",
          }}
        >
          Shop Inventory
        </h1>
        <p
          style={{
            margin: "8px 0 0",
            color: "#374151",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Stock counts are stored in Stripe product metadata. Setting a
          count to <strong>0</strong> hides the “Add to cart” button on
          the storefront and shows an out-of-stock badge. Leave a SKU
          untracked to keep the storefront treating it as always
          available.
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
          Preview mode: this environment has no Stripe key, so the
          catalog below is a built-in fixture and saves will fail with a
          clear error. Set <code>STRIPE_SECRET_KEY</code> to make
          inventory editable.
        </div>
      ) : null}

      {isLoading ? (
        <div style={{ color: "#6b7280" }}>Loading…</div>
      ) : isError ? (
        <div role="alert" style={{ color: "#b91c1c" }}>
          {error instanceof Error ? error.message : "Failed to load inventory."}
        </div>
      ) : !data || data.products.length === 0 ? (
        <div style={{ color: "#6b7280" }}>No products found.</div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <thead>
            <tr style={{ background: "#f9fafb", textAlign: "left" }}>
              <th style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                Product
              </th>
              <th style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                Price
              </th>
              <th style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                Stock
              </th>
              <th style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "#374151" }}>
                Edit
              </th>
            </tr>
          </thead>
          <tbody>
            {data.products.map((p) => (
              <tr
                key={p.id}
                style={{ borderTop: "1px solid #e5e7eb" }}
                data-testid={`inventory-row-${p.id}`}
              >
                <td style={{ padding: "12px", verticalAlign: "top" }}>
                  <div style={{ fontWeight: 500, color: "#0a1f44" }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                    {p.category} · {p.id}
                  </div>
                </td>
                <td style={{ padding: "12px", verticalAlign: "top" }}>
                  {formatPrice(p.priceCents, p.currency)}
                </td>
                <td style={{ padding: "12px", verticalAlign: "top" }}>
                  <StockBadge count={p.stockCount} />
                </td>
                <td style={{ padding: "12px", verticalAlign: "top" }}>
                  <StockCell
                    product={p}
                    onSaved={(next) => {
                      // Replace the row in the list cache so a
                      // subsequent refetch lines up with what the
                      // server already confirmed.
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
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
