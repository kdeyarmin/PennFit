// /admin/compliance-rules — per-payer CPAP adherence thresholds (mig
// 0212). The therapy-fleet + setup-adherence views classify patients
// against the CMS rule (>= 240 min on >= 21 of 30 nights) by default;
// a payer-specific rule here overrides min_minutes / required_nights for
// that insurance payer. The seeded "CMS default" (any payer) is the
// fallback; a more specific rule (lower priority number) wins.
//
// Mirrors the frequency-rules editor (pages/admin/rules.tsx): list +
// create / edit / toggle / delete, all invalidating the list query.
// Delete is admin-only (server enforces via requireAdminOnly).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label } from "@/components/admin/Input";
import { formatDateTime } from "@/lib/admin/format";
import { useAdminRole } from "@/lib/admin/role-context";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  COMPLIANCE_RULES_QUERY_KEY,
  createComplianceRule,
  deleteComplianceRule,
  describeComplianceRuleError,
  listComplianceRules,
  updateComplianceRule,
  type ComplianceRule,
  type ComplianceRuleCreate,
} from "@/lib/admin/compliance-rules-api";

interface FormState {
  name: string;
  priority: string;
  matchInsurancePayer: string;
  minMinutes: string;
  requiredNights: string;
  windowDays: string;
  active: boolean;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  priority: "100",
  matchInsurancePayer: "",
  minMinutes: "240",
  requiredNights: "21",
  windowDays: "30",
  active: true,
  notes: "",
};

export function AdminComplianceRulesPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: COMPLIANCE_RULES_QUERY_KEY,
    queryFn: listComplianceRules,
    staleTime: 30_000,
  });
  const [editing, setEditing] = useState<ComplianceRule | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div
      className="admin-root space-y-4 max-w-5xl p-6"
      data-testid="admin-compliance-rules-page"
    >
      <Header onCreate={() => setCreating(true)} />
      {isError ? (
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load compliance rules"
        />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading rules…" />
          ) : data.rules.length === 0 ? (
            <EmptyState
              title="No compliance rules configured."
              hint="The seeded CMS default (240 min / 21 nights) applies to every payer until you add an override."
            />
          ) : (
            <RulesTable rules={data.rules} onEdit={setEditing} />
          )}
        </Card>
      )}
      {creating && (
        <ComplianceRuleFormModal
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}
      {editing && (
        <ComplianceRuleFormModal
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Header({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Compliance rules
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Per-payer adherence thresholds. The CMS default (≥ 240 min on ≥ 21 of
          30 nights) applies to any payer without a more specific rule.
        </p>
      </div>
      <Button onClick={onCreate}>+ New rule</Button>
    </div>
  );
}

function hoursLabel(minutes: number): string {
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function RulesTable({
  rules,
  onEdit,
}: {
  rules: ComplianceRule[];
  onEdit: (rule: ComplianceRule) => void;
}) {
  const cols: Column<ComplianceRule>[] = [
    {
      key: "priority",
      header: "Pri",
      render: (r) => <span className="font-mono text-xs">{r.priority}</span>,
    },
    {
      key: "name",
      header: "Name",
      render: (r) => (
        <div>
          <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {r.name}
          </div>
          {r.notes && (
            <div
              className="text-xs whitespace-pre-wrap"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {r.notes}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "payer",
      header: "Payer",
      render: (r) =>
        r.matchInsurancePayer ? (
          r.matchInsurancePayer
        ) : (
          <span className="text-xs italic" style={{ color: "#9ca3af" }}>
            Any payer (default)
          </span>
        ),
    },
    {
      key: "threshold",
      header: "Threshold",
      render: (r) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
          ≥ {hoursLabel(r.minMinutes)} on ≥ {r.requiredNights} of {r.windowDays}{" "}
          nights
        </span>
      ),
    },
    {
      key: "active",
      header: "Active",
      render: (r) => (
        <Badge variant={r.active ? "success" : "muted"}>
          {r.active ? "On" : "Off"}
        </Badge>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      render: (r) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {formatDateTime(r.updatedAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: () => (
        <span
          className="text-xs underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Edit →
        </span>
      ),
    },
  ];

  return (
    <Table
      columns={cols}
      rows={rules}
      rowKey={(r) => r.id}
      onRowClick={(r) => onEdit(r)}
      emptyState={<EmptyState title="No rules." />}
    />
  );
}

function ruleToForm(rule: ComplianceRule): FormState {
  return {
    name: rule.name,
    priority: String(rule.priority),
    matchInsurancePayer: rule.matchInsurancePayer ?? "",
    minMinutes: String(rule.minMinutes),
    requiredNights: String(rule.requiredNights),
    windowDays: String(rule.windowDays),
    active: rule.active,
    notes: rule.notes ?? "",
  };
}

function parseRequiredInt(
  raw: string,
  field: string,
  min: number,
  max: number,
): { value: number; error: string | null } {
  if (raw.trim() === "") return { value: 0, error: `${field} is required.` };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      value: 0,
      error: `${field} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { value: n, error: null };
}

function ComplianceRuleFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: ComplianceRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [form, setForm] = useState<FormState>(
    initial ? ruleToForm(initial) : EMPTY_FORM,
  );
  const [error, setError] = useState<string | null>(null);
  const role = useAdminRole();

  const createMut = useMutation({
    mutationFn: (data: ComplianceRuleCreate) => createComplianceRule(data),
  });
  const updateMut = useMutation({
    mutationFn: (vars: { id: string; data: Partial<ComplianceRuleCreate> }) =>
      updateComplianceRule(vars.id, vars.data),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteComplianceRule(id),
  });

  const isPending =
    createMut.isPending || updateMut.isPending || deleteMut.isPending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isPending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isPending]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function buildBody(): {
    body: ComplianceRuleCreate | null;
    error: string | null;
  } {
    const name = form.name.trim();
    if (name === "") return { body: null, error: "Name is required." };
    if (name.length > 200) {
      return { body: null, error: "Name is too long (max 200 chars)." };
    }
    const priority = parseRequiredInt(form.priority, "Priority", 0, 100000);
    if (priority.error) return { body: null, error: priority.error };
    const minMinutes = parseRequiredInt(form.minMinutes, "Minutes", 0, 1440);
    if (minMinutes.error) return { body: null, error: minMinutes.error };
    const requiredNights = parseRequiredInt(
      form.requiredNights,
      "Required nights",
      1,
      30,
    );
    if (requiredNights.error)
      return { body: null, error: requiredNights.error };
    const windowDays = parseRequiredInt(form.windowDays, "Window days", 7, 90);
    if (windowDays.error) return { body: null, error: windowDays.error };
    if (requiredNights.value > windowDays.value) {
      return {
        body: null,
        error: "Required nights cannot exceed the window length.",
      };
    }
    const payer = form.matchInsurancePayer.trim();
    const notes = form.notes.trim();
    if (payer.length > 120) {
      return { body: null, error: "Payer is too long (max 120 chars)." };
    }
    if (notes.length > 2000) {
      return { body: null, error: "Notes are too long (max 2000 chars)." };
    }
    return {
      body: {
        name,
        priority: priority.value,
        matchInsurancePayer: payer === "" ? null : payer,
        minMinutes: minMinutes.value,
        requiredNights: requiredNights.value,
        windowDays: windowDays.value,
        active: form.active,
        notes: notes === "" ? null : notes,
      },
      error: null,
    };
  }

  async function invalidate() {
    await queryClient.invalidateQueries({
      queryKey: COMPLIANCE_RULES_QUERY_KEY,
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { body, error: validationError } = buildBody();
    if (!body) {
      setError(validationError);
      return;
    }
    try {
      if (mode === "create") {
        await createMut.mutateAsync(body);
      } else if (initial) {
        await updateMut.mutateAsync({ id: initial.id, data: body });
      }
      await invalidate();
      onSaved();
    } catch (err) {
      setError(describeComplianceRuleError(err));
    }
  }

  async function onToggleActive() {
    if (!initial) return;
    setError(null);
    try {
      await updateMut.mutateAsync({
        id: initial.id,
        data: { active: !initial.active },
      });
      await invalidate();
      onSaved();
    } catch (err) {
      setError(describeComplianceRuleError(err));
    }
  }

  async function onDelete() {
    if (!initial) return;
    if (
      !(await confirm({
        title: "Delete rule?",
        description: `Delete compliance rule "${initial.name}"? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    setError(null);
    try {
      await deleteMut.mutateAsync(initial.id);
      await invalidate();
      onSaved();
    } catch (err) {
      setError(describeComplianceRuleError(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !isPending && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="compliance-rule-form-title"
    >
      <div
        className="admin-root w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="p-6 space-y-4">
          <h2
            id="compliance-rule-form-title"
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {mode === "create" ? "New compliance rule" : "Edit compliance rule"}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label htmlFor="cr-name">Name</Label>
              <Input
                id="cr-name"
                value={form.name}
                maxLength={200}
                onChange={(e) => patch("name", e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="cr-priority">Priority</Label>
              <Input
                id="cr-priority"
                type="number"
                min={0}
                max={100000}
                value={form.priority}
                onChange={(e) => patch("priority", e.target.value)}
                required
                disabled={isPending}
              />
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Lower wins. The CMS default is 1000.
              </p>
            </div>
            <div>
              <Label htmlFor="cr-payer">Insurance payer (optional)</Label>
              <Input
                id="cr-payer"
                value={form.matchInsurancePayer}
                placeholder="blank = any payer"
                maxLength={120}
                onChange={(e) => patch("matchInsurancePayer", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="cr-minutes">Qualifying minutes / night</Label>
              <Input
                id="cr-minutes"
                type="number"
                min={0}
                max={1440}
                value={form.minMinutes}
                onChange={(e) => patch("minMinutes", e.target.value)}
                required
                disabled={isPending}
              />
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                240 = the CMS 4-hour rule.
              </p>
            </div>
            <div>
              <Label htmlFor="cr-nights">Required nights</Label>
              <Input
                id="cr-nights"
                type="number"
                min={1}
                max={30}
                value={form.requiredNights}
                onChange={(e) => patch("requiredNights", e.target.value)}
                required
                disabled={isPending}
              />
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                21 = the CMS rule. Max 30, and ≤ the window.
              </p>
            </div>
            <div>
              <Label htmlFor="cr-window">Window (days)</Label>
              <Input
                id="cr-window"
                type="number"
                min={7}
                max={90}
                value={form.windowDays}
                onChange={(e) => patch("windowDays", e.target.value)}
                required
                disabled={isPending}
              />
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Rolling window the nights are counted over. 30 = CMS.
              </p>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="cr-notes">Notes (optional)</Label>
              <textarea
                id="cr-notes"
                value={form.notes}
                onChange={(e) => patch("notes", e.target.value)}
                maxLength={2000}
                rows={3}
                className="block w-full rounded border px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2"
                style={{ borderColor: "#d1d5db", color: "hsl(var(--ink-1))" }}
                disabled={isPending}
              />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="cr-active"
                type="checkbox"
                checked={form.active}
                onChange={(e) => patch("active", e.target.checked)}
                disabled={isPending}
              />
              <label
                htmlFor="cr-active"
                className="text-sm"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Active — eligible for matching
              </label>
            </div>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
              {error}
            </p>
          )}

          <div
            className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <div className="flex gap-2">
              {mode === "edit" && initial && (
                <Button
                  intent="secondary"
                  type="button"
                  onClick={() => void onToggleActive()}
                  disabled={isPending}
                >
                  {initial.active ? "Deactivate" : "Activate"}
                </Button>
              )}
              {mode === "edit" && initial && role === "admin" && (
                <Button
                  intent="ghost"
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={isPending}
                  className="!text-red-700"
                >
                  Delete
                </Button>
              )}
              {mode === "edit" && initial && role === "agent" && (
                <span
                  className="text-xs italic px-2 py-1"
                  style={{ color: "#7a7a7a" }}
                  title="Deleting compliance rules requires an admin account. Toggle the rule inactive instead."
                  data-testid="compliance-rules-delete-blocked-agent"
                >
                  Delete is admin-only
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                intent="secondary"
                type="button"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" isLoading={isPending}>
                {mode === "create" ? "Create rule" : "Save changes"}
              </Button>
            </div>
          </div>
        </form>
      </div>
      {ConfirmDialogEl}
    </div>
  );
}
