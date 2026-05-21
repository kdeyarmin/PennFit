import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";

import {
  getReconciliation,
  ReconciliationUnavailableError,
  submitReconciliation,
  type ReconciliationDetail,
} from "@/lib/admin/inventory-reconciliation-api";

// Inventory reconciliation edit page.
//
// Three modes, all rendered by this one component:
//   - draft, catalog loaded → editable grid (one row per SKU), submit
//   - draft, catalog unavailable → 503 banner + back link
//   - submitted               → read-only line list with variances
//
// Optimistic-update is deliberately NOT used here. Submit is a single
// terminal action — the operator hits submit once per reconciliation,
// then the page transitions to the read-only view. Local form state
// + a single mutation is simpler than juggling cache rewrites.

interface DraftLine {
  productId: string;
  productName: string;
  systemCount: number | null;
  countedQty: string; // raw input — parsed at submit
}

function buildDraftLines(detail: ReconciliationDetail): DraftLine[] {
  if (!detail.currentProducts) return [];
  return detail.currentProducts
    .map((p) => ({
      productId: p.productId,
      productName: p.name,
      systemCount: p.systemCount,
      countedQty: "",
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

function parseCounted(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (n < 0 || n > 1_000_000) return null;
  return n;
}

function computeVariance(
  systemCount: number | null,
  counted: number | null,
): number | null {
  if (counted === null) return null;
  if (systemCount === null) return counted;
  return counted - systemCount;
}

export function AdminShopInventoryReconcileEditPage() {
  const [, params] = useRoute<{ id: string }>(
    "/admin/shop/inventory/reconcile/:id",
  );
  const id = params?.id ?? "";
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const QUERY_KEY = useMemo(() => ["inventory-reconciliation", id] as const, [
    id,
  ]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getReconciliation(id),
    enabled: id.length > 0,
  });

  const [drafts, setDrafts] = useState<DraftLine[] | null>(null);
  const [applyToStripe, setApplyToStripe] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hydrate draft state once the detail lands. Keyed on the
  // reconciliation id so a navigation between two drafts re-seeds the
  // grid, but a refetch of the same draft does not — the operator's
  // typed counts must survive a background refetch. The condition
  // inside `useEffect` is the same guard the older setState-in-render
  // pattern carried (only seed when null), but lifted out of the
  // render body so React StrictMode + the concurrent renderer don't
  // double-schedule the update or drop user input during the gap.
  const detailKey =
    data && data.reconciliation.status === "draft"
      ? `${data.reconciliation.id}:${data.currentProducts?.length ?? 0}`
      : null;
  useEffect(() => {
    if (!data || data.reconciliation.status !== "draft") return;
    if (drafts !== null) return;
    setDrafts(buildDraftLines(data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailKey]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!drafts) throw new Error("No lines to submit.");
      const lines: Array<{ productId: string; countedQty: number }> = [];
      for (const draft of drafts) {
        const counted = parseCounted(draft.countedQty);
        if (counted === null) continue; // skip blank/invalid rows
        lines.push({ productId: draft.productId, countedQty: counted });
      }
      if (lines.length === 0) {
        throw new Error("Enter at least one counted quantity.");
      }
      return submitReconciliation(id, { lines, applyToStripe });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: ["inventory-reconciliations"],
      });
      // Stay on the same page — the detail query will refetch and
      // render the submitted view.
    },
    onError: (err) => {
      if (err instanceof ReconciliationUnavailableError) {
        setSubmitError(
          err.reason === "stripe_not_configured"
            ? "Stripe is not configured in this environment — submit unavailable."
            : "Could not load the live Stripe catalog. Retry in a minute.",
        );
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "Submit failed.");
    },
  });

  function updateDraft(productId: string, countedQty: string) {
    setDrafts((prev) =>
      prev
        ? prev.map((d) =>
            d.productId === productId ? { ...d, countedQty } : d,
          )
        : prev,
    );
    if (submitError) setSubmitError(null);
  }

  if (id.length === 0) {
    return (
      <div className="admin-root" style={{ maxWidth: 720 }}>
        <p style={{ color: "#b91c1c" }}>Missing reconciliation id.</p>
      </div>
    );
  }

  return (
    <div className="admin-root" style={{ maxWidth: 980 }}>
      <header style={{ marginBottom: 24 }}>
        <a
          href={`${import.meta.env.BASE_URL}admin/shop/inventory/reconcile`}
          style={{
            color: "hsl(var(--ink-1))",
            fontSize: 13,
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 8,
          }}
        >
          ← Back to reconciliations
        </a>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "hsl(var(--ink-1))",
          }}
        >
          {data ? `Reconciliation — ${data.reconciliation.periodLabel}` : "Reconciliation"}
        </h1>
      </header>

      {isLoading ? (
        <div style={{ color: "hsl(var(--ink-3))" }}>Loading…</div>
      ) : isError ? (
        <div role="alert" style={{ color: "#b91c1c" }}>
          {error instanceof Error
            ? error.message
            : "Failed to load reconciliation."}
        </div>
      ) : !data ? (
        <div role="alert" style={{ color: "#b91c1c" }}>
          Not found.
        </div>
      ) : data.reconciliation.status === "submitted" ? (
        <SubmittedView data={data} />
      ) : !data.currentProducts ? (
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
          The live Stripe catalog could not be loaded. The form needs the
          current stock counts to compute variance — please retry in a
          minute, or set <code>STRIPE_SECRET_KEY</code> if this is a
          preview environment.
        </div>
      ) : (
        <DraftView
          drafts={drafts ?? buildDraftLines(data)}
          onChange={updateDraft}
          applyToStripe={applyToStripe}
          setApplyToStripe={setApplyToStripe}
          onSubmit={() => {
            setSubmitError(null);
            submitMutation.mutate();
          }}
          submitting={submitMutation.isPending}
          submitError={submitError}
          onCancel={() => setLocation("/admin/shop/inventory/reconcile")}
        />
      )}
    </div>
  );
}

function DraftView({
  drafts,
  onChange,
  applyToStripe,
  setApplyToStripe,
  onSubmit,
  submitting,
  submitError,
  onCancel,
}: {
  drafts: DraftLine[];
  onChange: (productId: string, countedQty: string) => void;
  applyToStripe: boolean;
  setApplyToStripe: (v: boolean) => void;
  onSubmit: () => void;
  submitting: boolean;
  submitError: string | null;
  onCancel: () => void;
}) {
  const filledCount = drafts.filter((d) => parseCounted(d.countedQty) !== null)
    .length;

  return (
    <>
      <p
        style={{
          color: "hsl(var(--ink-2))",
          fontSize: 14,
          marginTop: 0,
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        Enter the physical count for each SKU you counted. Leave a row blank
        to skip it — only filled rows are recorded. Variance updates live as
        you type.
      </p>

      <div style={{ overflowX: "auto", marginBottom: 16 }}>
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
              <th style={ThStyle}>Product</th>
              <th style={{ ...ThStyle, textAlign: "right" }}>System count</th>
              <th style={{ ...ThStyle, textAlign: "right" }}>Counted</th>
              <th style={{ ...ThStyle, textAlign: "right" }}>Variance</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => {
              const parsed = parseCounted(d.countedQty);
              const variance = computeVariance(d.systemCount, parsed);
              const invalid =
                d.countedQty.trim() !== "" && parsed === null;
              return (
                <tr
                  key={d.productId}
                  style={{ borderTop: "1px solid #e5e7eb" }}
                  data-testid={`reconcile-line-${d.productId}`}
                >
                  <td
                    style={{
                      padding: "10px 12px",
                      fontSize: 13,
                      color: "hsl(var(--ink-1))",
                    }}
                  >
                    {d.productName}
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      fontSize: 13,
                      textAlign: "right",
                      color: "hsl(var(--ink-2))",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {d.systemCount === null ? "—" : d.systemCount}
                  </td>
                  <td
                    style={{
                      padding: "8px 12px",
                      textAlign: "right",
                    }}
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      value={d.countedQty}
                      onChange={(e) => onChange(d.productId, e.target.value)}
                      data-testid={`reconcile-input-${d.productId}`}
                      disabled={submitting}
                      placeholder="—"
                      aria-label={`Counted quantity for ${d.productName}`}
                      style={{
                        width: 96,
                        padding: "6px 8px",
                        border: `1px solid ${invalid ? "#dc2626" : "#d1d5db"}`,
                        borderRadius: 4,
                        fontSize: 14,
                        fontFamily: "inherit",
                        textAlign: "right",
                      }}
                    />
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      fontSize: 13,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        variance === null
                          ? "hsl(var(--ink-3))"
                          : variance === 0
                            ? "hsl(var(--ink-2))"
                            : variance > 0
                              ? "#166534"
                              : "#b91c1c",
                      fontWeight: variance && variance !== 0 ? 600 : 400,
                    }}
                  >
                    {variance === null
                      ? "—"
                      : variance > 0
                        ? `+${variance}`
                        : String(variance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 14,
          color: "hsl(var(--ink-1))",
          marginBottom: 16,
        }}
      >
        <input
          type="checkbox"
          checked={applyToStripe}
          onChange={(e) => setApplyToStripe(e.target.checked)}
          data-testid="reconcile-apply-toggle"
          disabled={submitting}
        />
        Apply counted quantities to Stripe stock counts on submit
      </label>

      {submitError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "10px 14px",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          {submitError}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || filledCount === 0}
          data-testid="reconcile-submit-btn"
          style={{
            background: filledCount === 0 ? "#9ca3af" : "#0a1f44",
            color: "#fff",
            border: "none",
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 6,
            cursor:
              submitting || filledCount === 0 ? "not-allowed" : "pointer",
          }}
        >
          {submitting
            ? "Submitting…"
            : `Submit ${filledCount} count${filledCount === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            background: "#fff",
            color: "hsl(var(--ink-2))",
            border: "1px solid #d1d5db",
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            borderRadius: 6,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
        <span
          style={{
            color: "hsl(var(--ink-3))",
            fontSize: 13,
            marginLeft: 4,
          }}
        >
          {filledCount} of {drafts.length} rows filled
        </span>
      </div>
    </>
  );
}

function SubmittedView({ data }: { data: ReconciliationDetail }) {
  const { reconciliation, lines } = data;
  return (
    <>
      <div
        style={{
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 16,
        }}
      >
        <Stat label="Status" value="Submitted" />
        <Stat label="Started by" value={reconciliation.startedByEmail} />
        <Stat label="Lines" value={String(reconciliation.totalLines)} />
        <Stat
          label="Total variance (units)"
          value={String(reconciliation.totalVarianceUnits)}
        />
        <Stat
          label="Applied to Stripe"
          value={reconciliation.appliedToStripe ? "Yes" : "No"}
        />
      </div>

      {reconciliation.notes ? (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 16,
            marginBottom: 20,
            fontSize: 14,
            color: "hsl(var(--ink-1))",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {reconciliation.notes}
        </div>
      ) : null}

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
              <th style={ThStyle}>Product</th>
              <th style={{ ...ThStyle, textAlign: "right" }}>System</th>
              <th style={{ ...ThStyle, textAlign: "right" }}>Counted</th>
              <th style={{ ...ThStyle, textAlign: "right" }}>Variance</th>
              <th style={ThStyle}>Applied</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr
                key={l.id}
                style={{ borderTop: "1px solid #e5e7eb" }}
                data-testid={`reconcile-result-${l.productId}`}
              >
                <td
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    color: "hsl(var(--ink-1))",
                  }}
                >
                  {l.productName}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    textAlign: "right",
                    color: "hsl(var(--ink-2))",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {l.systemCount === null ? "—" : l.systemCount}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {l.countedQty}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color:
                      l.variance === 0
                        ? "hsl(var(--ink-2))"
                        : l.variance > 0
                          ? "#166534"
                          : "#b91c1c",
                    fontWeight: l.variance !== 0 ? 600 : 400,
                  }}
                >
                  {l.variance > 0 ? `+${l.variance}` : String(l.variance)}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    color: "hsl(var(--ink-2))",
                  }}
                >
                  {l.applied ? "Yes" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "hsl(var(--ink-3))",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "hsl(var(--ink-1))",
        }}
      >
        {value}
      </div>
    </div>
  );
}

const ThStyle: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "hsl(var(--ink-2))",
};
