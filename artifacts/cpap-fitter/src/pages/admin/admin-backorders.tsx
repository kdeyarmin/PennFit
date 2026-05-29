// /admin/shop/backorders — CSR-managed backorder list + SKU
// substitution catalog. Two panels side-by-side. When a CSR marks
// a SKU backordered, any subsequent resupply confirmation through
// that SKU will substitute via shop_sku_substitutes (priority asc).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, ArrowRight, Plus, Trash2 } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  clearBackorder,
  createSubstitute,
  deleteSubstitute,
  listBackorders,
  listSubstitutes,
  markBackorder,
  patchSubstitute,
  type Backorder,
  type SkuSubstitute,
} from "@/lib/admin/backorders-api";

export function AdminBackordersPage() {
  return (
    <div className="admin-root p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <AlertOctagon className="h-6 w-6" />
          Backorders & substitutes
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          When a SKU is backordered, the next resupply confirmation
          automatically substitutes from the catalog below. Substitution rules
          are admin-curated; backorder marks are CSR-managed.
        </p>
      </header>

      <div className="grid lg:grid-cols-2 gap-6">
        <BackordersPanel />
        <SubstitutesPanel />
      </div>
    </div>
  );
}

function BackordersPanel() {
  const qc = useQueryClient();
  const queryKey = ["admin", "shop", "backorders"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listBackorders,
  });
  const [sku, setSku] = useState("");
  const [notes, setNotes] = useState("");
  const mark = useMutation({
    mutationFn: () =>
      markBackorder({ sku: sku.trim(), notes: notes.trim() || undefined }),
    onSuccess: () => {
      setSku("");
      setNotes("");
      void qc.invalidateQueries({ queryKey });
    },
  });
  const clear = useMutation({
    mutationFn: (id: string) => clearBackorder(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
  });

  const skuValid = /^[A-Za-z0-9_-]{1,64}$/.test(sku.trim());
  return (
    <Card title="Active backorders">
      <div className="flex flex-wrap gap-2 items-end mb-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            SKU
          </label>
          <Input
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="AF20-S"
            aria-label="SKU"
            style={{ width: "10rem", fontFamily: "monospace" }}
          />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Notes (optional)
          </label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="ETA from Pacware: 5/22"
            aria-label="Notes"
          />
        </div>
        <Button
          disabled={!skuValid || mark.isPending}
          isLoading={mark.isPending}
          onClick={() => mark.mutate()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Mark
        </Button>
      </div>
      {mark.error instanceof Error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900 mb-3">
          {mark.error.message}
        </div>
      )}
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.backorders.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No backorders on file.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <th className="py-2 font-semibold">SKU</th>
              <th className="py-2 font-semibold">State</th>
              <th className="py-2 font-semibold">Notes</th>
              <th className="py-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {data.backorders.map((b) => (
              <BackorderRow
                key={b.id}
                row={b}
                onClear={() => clear.mutate(b.id)}
                clearPending={clear.isPending}
              />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function BackorderRow({
  row,
  onClear,
  clearPending,
}: {
  row: Backorder;
  onClear: () => void;
  clearPending: boolean;
}) {
  const isActive = row.clearedAt == null;
  return (
    <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
      <td className="py-1.5 font-mono text-xs">{row.sku}</td>
      <td className="py-1.5">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${
            isActive
              ? "bg-rose-100 text-rose-900"
              : "bg-slate-200 text-slate-700"
          }`}
        >
          {isActive
            ? `since ${new Date(row.markedAt).toLocaleDateString()}`
            : `cleared ${new Date(row.clearedAt!).toLocaleDateString()}`}
        </span>
      </td>
      <td className="py-1.5 text-xs text-muted-foreground">
        {row.notes ?? "—"}
      </td>
      <td className="py-1.5 text-right">
        {isActive && (
          <Button
            intent="ghost"
            size="sm"
            onClick={onClear}
            isLoading={clearPending}
          >
            Clear
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * Render the substitution catalog panel with UI to list, add, toggle, and delete SKU substitution rules.
 *
 * Renders a form for creating new substitutes (primary SKU, alternative SKU, priority), a table of existing
 * substitution rules with controls to toggle active/paused state and delete entries (deletion requires confirmation),
 * and handles loading, empty, and error states for the substitutes query.
 *
 * @returns A React element containing the substitution catalog UI, including the add form, substitutes table, and confirmation dialog.
 */
function SubstitutesPanel() {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const queryKey = ["admin", "shop", "substitutes"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listSubstitutes(),
  });
  const [primary, setPrimary] = useState("");
  const [alternative, setAlternative] = useState("");
  const [priority, setPriority] = useState("100");
  const create = useMutation({
    mutationFn: () =>
      createSubstitute({
        primarySku: primary.trim(),
        alternativeSku: alternative.trim(),
        priority: Number(priority) || 100,
      }),
    onSuccess: () => {
      setPrimary("");
      setAlternative("");
      setPriority("100");
      void qc.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSubstitute(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
  });
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      patchSubstitute(id, { active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
  });

  const valid =
    /^[A-Za-z0-9_-]{1,64}$/.test(primary.trim()) &&
    /^[A-Za-z0-9_-]{1,64}$/.test(alternative.trim()) &&
    primary.trim() !== alternative.trim();

  return (
    <Card title="Substitution catalog">
      <div className="flex flex-wrap gap-2 items-end mb-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Primary SKU
          </label>
          <Input
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            placeholder="AF20-S"
            aria-label="Primary SKU"
            style={{ width: "8rem", fontFamily: "monospace" }}
          />
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground self-center mt-4" />
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Alternative
          </label>
          <Input
            value={alternative}
            onChange={(e) => setAlternative(e.target.value)}
            placeholder="AF20-M"
            aria-label="Alternative SKU"
            style={{ width: "8rem", fontFamily: "monospace" }}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Priority
          </label>
          <Input
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value.replace(/\D/g, "").slice(0, 4))
            }
            inputMode="numeric"
            aria-label="Priority"
            style={{ width: "4rem", fontFamily: "monospace" }}
          />
        </div>
        <Button
          disabled={!valid || create.isPending}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>
      {create.error instanceof Error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900 mb-3">
          {create.error.message}
        </div>
      )}
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.substitutes.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No substitution rules yet. Lower priority numbers run first.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <th className="py-2 font-semibold">Primary</th>
              <th className="py-2 font-semibold">Alternative</th>
              <th className="py-2 font-semibold">Pri.</th>
              <th className="py-2 font-semibold">Active</th>
              <th className="py-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {data.substitutes.map((s) => (
              <SubstituteRow
                key={s.id}
                row={s}
                onToggle={() => toggle.mutate({ id: s.id, active: !s.active })}
                onDelete={async () => {
                  if (
                    !(await confirm({
                      title: "Delete substitute?",
                      description: `Delete substitute ${s.primarySku} → ${s.alternativeSku}?`,
                      confirmLabel: "Delete",
                      destructive: true,
                    }))
                  )
                    return;
                  remove.mutate(s.id);
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      {ConfirmDialogEl}
    </Card>
  );
}

function SubstituteRow({
  row,
  onToggle,
  onDelete,
}: {
  row: SkuSubstitute;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
      <td className="py-1.5 font-mono text-xs">{row.primarySku}</td>
      <td className="py-1.5 font-mono text-xs">{row.alternativeSku}</td>
      <td className="py-1.5 font-mono tabular-nums">{row.priority}</td>
      <td className="py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${
            row.active
              ? "bg-emerald-100 text-emerald-900"
              : "bg-slate-200 text-slate-700"
          }`}
        >
          {row.active ? "active" : "paused"}
        </button>
      </td>
      <td className="py-1.5 text-right">
        <Button
          intent="ghost"
          size="sm"
          onClick={onDelete}
          aria-label="Delete substitute"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  );
}
