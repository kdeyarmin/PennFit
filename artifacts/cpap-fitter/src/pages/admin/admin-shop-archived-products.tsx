import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  InventoryUnavailableError,
  listArchivedShopProducts,
  restoreShopProduct,
  SkuConflictError,
  type ArchivedShopProductRow,
} from "@/lib/admin/shop-inventory-api";

// Archived Shop Products page — the restore half of the retire/restore
// lifecycle. Lists every archived SKU still carrying shop metadata and
// offers a confirm-guarded Restore action, so bringing a product back
// no longer requires the Stripe Dashboard. Admin-role only (the API
// gates both the list and the restore behind requireAdminOnly; agents
// see the server's 403 explanation).

const ARCHIVED_QUERY_KEY = ["shop-archived-products"] as const;

function formatArchivedAt(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  try {
    return new Date(epochSeconds * 1000).toLocaleDateString();
  } catch {
    return "—";
  }
}

export function AdminShopArchivedProductsPage() {
  const queryClient = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const archivedQuery = useQuery({
    queryKey: ARCHIVED_QUERY_KEY,
    queryFn: listArchivedShopProducts,
  });

  const restoreMutation = useMutation({
    mutationFn: (productId: string) => restoreShopProduct(productId),
    onSuccess: () => {
      // Refresh this list AND the inventory grid (the restored SKU
      // reappears there; key kept in lockstep with QUERY_KEY in
      // admin-shop-inventory.tsx).
      void queryClient.invalidateQueries({ queryKey: ARCHIVED_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["shop-inventory"] });
    },
    onError: (err) => {
      if (err instanceof SkuConflictError) {
        setError(
          "An active product already uses this SKU — it was re-created " +
            "after this one was archived. Archive the newer product first " +
            "(or keep it and leave this one archived)." +
            (err.conflictingProductId
              ? ` Conflicting product: ${err.conflictingProductId}`
              : ""),
        );
        return;
      }
      if (err instanceof InventoryUnavailableError) {
        setError(
          "Stripe is not configured in this environment — set STRIPE_SECRET_KEY to restore products.",
        );
        return;
      }
      setError(err instanceof Error ? err.message : "Restore failed");
    },
    onSettled: () => {
      setRestoringId(null);
    },
  });

  async function onRestore(row: ArchivedShopProductRow) {
    setError(null);
    const confirmed = await confirm({
      title: "Restore to storefront?",
      description: `"${row.name}" becomes visible and purchasable on the shop again within seconds.`,
      confirmLabel: "Restore",
    });
    if (!confirmed) return;
    setRestoringId(row.id);
    restoreMutation.mutate(row.id);
  }

  const rows = archivedQuery.data ?? [];

  return (
    <div style={{ maxWidth: 860 }}>
      <header style={{ marginBottom: 24 }}>
        <a
          href={`${import.meta.env.BASE_URL}admin/shop/inventory`}
          style={{
            color: "hsl(var(--ink-1))",
            fontSize: 13,
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 8,
          }}
        >
          ← Back to inventory
        </a>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "hsl(var(--ink-1))",
          }}
        >
          Archived Products
        </h1>
        <p
          style={{
            margin: "8px 0 0",
            color: "hsl(var(--ink-2))",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          SKUs removed from the storefront. Restoring makes a product visible
          and purchasable again at its previous price, stock count, and photo.
          Admin role required.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "12px 16px",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      ) : null}

      {archivedQuery.isLoading ? (
        <p style={{ color: "hsl(var(--ink-2))", fontSize: 14 }}>
          Loading archived products…
        </p>
      ) : archivedQuery.isError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "12px 16px",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {archivedQuery.error instanceof InventoryUnavailableError
            ? "Stripe is not configured in this environment — set STRIPE_SECRET_KEY to list archived products."
            : "Could not load archived products — try again."}
        </div>
      ) : rows.length === 0 ? (
        <p
          data-testid="archived-empty"
          style={{ color: "hsl(var(--ink-3))", fontSize: 14 }}
        >
          No archived products. Items archived from the inventory page will
          appear here.
        </p>
      ) : (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            background: "#fff",
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  background: "#f9fafb",
                  textAlign: "left",
                  fontSize: 13,
                  color: "hsl(var(--ink-2))",
                }}
              >
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>
                  Product
                </th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>
                  Category
                </th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }}>
                  Archived
                </th>
                <th style={{ padding: "10px 12px", fontWeight: 600 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  style={{ borderTop: "1px solid #e5e7eb", fontSize: 14 }}
                  data-testid={`archived-row-${row.id}`}
                >
                  <td style={{ padding: "12px", verticalAlign: "top" }}>
                    <div
                      style={{ fontWeight: 500, color: "hsl(var(--ink-1))" }}
                    >
                      {row.name}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "hsl(var(--ink-3))",
                        marginTop: 2,
                      }}
                    >
                      {row.sku ?? row.id}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "12px",
                      verticalAlign: "top",
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    {row.category ?? "—"}
                  </td>
                  <td
                    style={{
                      padding: "12px",
                      verticalAlign: "top",
                      color: "hsl(var(--ink-2))",
                    }}
                  >
                    {formatArchivedAt(row.updatedAt)}
                  </td>
                  <td
                    style={{
                      padding: "12px",
                      verticalAlign: "top",
                      textAlign: "right",
                    }}
                  >
                    <button
                      type="button"
                      data-testid={`restore-${row.id}`}
                      disabled={restoreMutation.isPending}
                      onClick={() => void onRestore(row)}
                      style={{
                        background: "#0a1f44",
                        color: "#fff",
                        border: "none",
                        padding: "6px 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        borderRadius: 6,
                        cursor: restoreMutation.isPending ? "wait" : "pointer",
                        opacity:
                          restoreMutation.isPending && restoringId === row.id
                            ? 0.7
                            : 1,
                      }}
                    >
                      {restoreMutation.isPending && restoringId === row.id
                        ? "Restoring…"
                        : "Restore"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ConfirmDialogEl}
    </div>
  );
}
