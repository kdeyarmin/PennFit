import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getListRulesQueryKey,
  useCreateRule,
  useDeleteRule,
  useListRules,
  useUpdateRule,
  type FrequencyRule,
  type FrequencyRuleCreate,
  type FrequencyRuleUpdate,
} from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import { Badge } from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Button } from "../components/Button";
import { Input, Label, Select } from "../components/Input";
import { formatDateTime } from "../lib/format";

// Penn Resupply — Global frequency rules.
//
// Rules are consulted by the eligibility engine when a patient has
// no per-patient override. Resolution order is:
//   1. patient.cadence_override_days / patient.channel_preference
//   2. first active rule (priority asc, created_at asc) where
//      sku-prefix / payer / tenure-window all match
//   3. prescription.cadence_days fallback
//
// This page lets operators view, create, edit, toggle, and delete
// rules. The "priority" column is editable inline via the edit
// modal — we deliberately do NOT use drag-handles here:
//   - the wider app already uses keyboard-friendly forms everywhere
//   - drag reordering would require a server-side bulk update
//     endpoint we haven't built (and don't need at this scale)
//   - operators can simply edit the integer to re-rank a rule
//
// All mutations invalidate the rules list query so the table
// reflects the latest state without a manual refresh.

type ChannelChoice = "" | "sms" | "email" | "voice";

interface FormState {
  name: string;
  priority: string;
  matchItemSkuPrefix: string;
  matchInsurancePayer: string;
  minTenureDays: string;
  maxTenureDays: string;
  cadenceDays: string;
  defaultChannel: ChannelChoice;
  active: boolean;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  priority: "100",
  matchItemSkuPrefix: "",
  matchInsurancePayer: "",
  minTenureDays: "",
  maxTenureDays: "",
  cadenceDays: "30",
  defaultChannel: "",
  active: true,
  notes: "",
};

export function RulesPage() {
  const { data, isPending, isError, error, refetch } = useListRules();
  const [editing, setEditing] = useState<FrequencyRule | null>(null);
  const [creating, setCreating] = useState(false);

  if (isError) {
    return (
      <div className="space-y-4 max-w-5xl">
        <Header onCreate={() => setCreating(true)} />
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load rules"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <Header onCreate={() => setCreating(true)} />
      <Card>
        {isPending ? (
          <Spinner label="Loading rules…" />
        ) : data.rules.length === 0 ? (
          <EmptyState
            title="No frequency rules configured."
            hint="Add a rule to set defaults for a therapy type, payer, or tenure window."
          />
        ) : (
          <RulesTable rules={data.rules} onEdit={setEditing} />
        )}
      </Card>
      {creating && (
        <RuleFormModal
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}
      {editing && (
        <RuleFormModal
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
          style={{ color: "#0a1f44" }}
        >
          Frequency rules
        </h1>
        <p className="text-sm" style={{ color: "#6b7280" }}>
          Default reminder cadences and channels by therapy type,
          payer, and customer tenure. Per-patient overrides always
          win.
        </p>
      </div>
      <Button onClick={onCreate}>+ New rule</Button>
    </div>
  );
}

function RulesTable({
  rules,
  onEdit,
}: {
  rules: FrequencyRule[];
  onEdit: (rule: FrequencyRule) => void;
}) {
  const cols: Column<FrequencyRule>[] = [
    {
      key: "priority",
      header: "Pri",
      render: (r) => (
        <span className="font-mono text-xs">{r.priority}</span>
      ),
    },
    {
      key: "name",
      header: "Name",
      render: (r) => (
        <div>
          <div className="font-semibold" style={{ color: "#0a1f44" }}>
            {r.name}
          </div>
          {r.notes && (
            <div
              className="text-xs whitespace-pre-wrap"
              style={{ color: "#6b7280" }}
            >
              {r.notes}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "match",
      header: "Matches",
      render: (r) => <MatchSummary rule={r} />,
    },
    {
      key: "cadence",
      header: "Cadence",
      render: (r) => `${r.cadenceDays} d`,
    },
    {
      key: "channel",
      header: "Channel",
      render: (r) =>
        r.defaultChannel ? (
          <Badge variant="info">{r.defaultChannel.toUpperCase()}</Badge>
        ) : (
          <span style={{ color: "#9ca3af" }}>—</span>
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
        <span className="text-xs" style={{ color: "#6b7280" }}>
          {formatDateTime(r.updatedAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: () => (
        <span className="text-xs underline" style={{ color: "#0a1f44" }}>
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

function MatchSummary({ rule }: { rule: FrequencyRule }) {
  const parts: string[] = [];
  if (rule.matchItemSkuPrefix) parts.push(`SKU starts with ${rule.matchItemSkuPrefix}`);
  if (rule.matchInsurancePayer) parts.push(`Payer = ${rule.matchInsurancePayer}`);
  if (rule.minTenureDays != null && rule.maxTenureDays != null) {
    parts.push(`Tenure ${rule.minTenureDays}–${rule.maxTenureDays}d`);
  } else if (rule.minTenureDays != null) {
    parts.push(`Tenure ≥ ${rule.minTenureDays}d`);
  } else if (rule.maxTenureDays != null) {
    parts.push(`Tenure ≤ ${rule.maxTenureDays}d`);
  }
  if (parts.length === 0) {
    return (
      <span className="text-xs italic" style={{ color: "#9ca3af" }}>
        Matches everything
      </span>
    );
  }
  return (
    <ul className="text-xs space-y-0.5" style={{ color: "#374151" }}>
      {parts.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

// ----------------------
// Create / edit modal
// ----------------------

function ruleToForm(rule: FrequencyRule): FormState {
  return {
    name: rule.name,
    priority: String(rule.priority),
    matchItemSkuPrefix: rule.matchItemSkuPrefix ?? "",
    matchInsurancePayer: rule.matchInsurancePayer ?? "",
    minTenureDays:
      rule.minTenureDays != null ? String(rule.minTenureDays) : "",
    maxTenureDays:
      rule.maxTenureDays != null ? String(rule.maxTenureDays) : "",
    cadenceDays: String(rule.cadenceDays),
    defaultChannel: (rule.defaultChannel ?? "") as ChannelChoice,
    active: rule.active,
    notes: rule.notes ?? "",
  };
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? "Couldn't save rule.";
  }
  return err instanceof Error ? err.message : "Couldn't save rule.";
}

function parseOptionalInt(
  raw: string,
  field: string,
  min: number,
  max: number,
): { value: number | null; error: string | null } {
  if (raw.trim() === "") return { value: null, error: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      value: null,
      error: `${field} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { value: n, error: null };
}

function parseRequiredInt(
  raw: string,
  field: string,
  min: number,
  max: number,
): { value: number; error: string | null } {
  if (raw.trim() === "") {
    return { value: 0, error: `${field} is required.` };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      value: 0,
      error: `${field} must be a whole number between ${min} and ${max}.`,
    };
  }
  return { value: n, error: null };
}

function RuleFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: FrequencyRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(
    initial ? ruleToForm(initial) : EMPTY_FORM,
  );
  const [error, setError] = useState<string | null>(null);

  const createMut = useCreateRule();
  const updateMut = useUpdateRule();
  const deleteMut = useDeleteRule();

  const isPending =
    createMut.isPending || updateMut.isPending || deleteMut.isPending;

  // Esc closes the modal — small a11y win without pulling in a focus
  // trap library. The backdrop click also closes (handler below).
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

  function buildBody(): { body: FrequencyRuleCreate | null; error: string | null } {
    const name = form.name.trim();
    if (name === "") return { body: null, error: "Name is required." };
    if (name.length > 200) {
      return { body: null, error: "Name is too long (max 200 chars)." };
    }
    const cadence = parseRequiredInt(form.cadenceDays, "Cadence days", 1, 365);
    if (cadence.error) return { body: null, error: cadence.error };
    const priority = parseRequiredInt(form.priority, "Priority", 0, 100000);
    if (priority.error) return { body: null, error: priority.error };
    const minTen = parseOptionalInt(form.minTenureDays, "Min tenure", 0, 36500);
    if (minTen.error) return { body: null, error: minTen.error };
    const maxTen = parseOptionalInt(form.maxTenureDays, "Max tenure", 0, 36500);
    if (maxTen.error) return { body: null, error: maxTen.error };
    if (
      minTen.value != null &&
      maxTen.value != null &&
      minTen.value > maxTen.value
    ) {
      return {
        body: null,
        error: "Min tenure cannot be greater than max tenure.",
      };
    }
    const skuPrefix = form.matchItemSkuPrefix.trim();
    const payer = form.matchInsurancePayer.trim();
    const notes = form.notes.trim();
    if (skuPrefix.length > 120) {
      return { body: null, error: "SKU prefix is too long (max 120 chars)." };
    }
    if (payer.length > 120) {
      return { body: null, error: "Payer is too long (max 120 chars)." };
    }
    if (notes.length > 2000) {
      return { body: null, error: "Notes are too long (max 2000 chars)." };
    }

    const body: FrequencyRuleCreate = {
      name,
      priority: priority.value,
      cadenceDays: cadence.value,
      matchItemSkuPrefix: skuPrefix === "" ? null : skuPrefix,
      matchInsurancePayer: payer === "" ? null : payer,
      minTenureDays: minTen.value,
      maxTenureDays: maxTen.value,
      defaultChannel:
        form.defaultChannel === "" ? null : form.defaultChannel,
      active: form.active,
      notes: notes === "" ? null : notes,
    };
    return { body, error: null };
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
        await createMut.mutateAsync({ data: body });
      } else if (initial) {
        // For edit we can send the full body as a PATCH — every
        // field shape lines up with FrequencyRuleUpdate.
        await updateMut.mutateAsync({
          id: initial.id,
          data: body as FrequencyRuleUpdate,
        });
      }
      await queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
      onSaved();
    } catch (err) {
      setError(describeError(err));
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
      await queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function onDelete() {
    if (!initial) return;
    if (
      !window.confirm(
        `Delete rule "${initial.name}"? This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await deleteMut.mutateAsync({ id: initial.id });
      await queryClient.invalidateQueries({ queryKey: getListRulesQueryKey() });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !isPending && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rule-form-title"
    >
      <div
        className="w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="p-6 space-y-4">
          <h2
            id="rule-form-title"
            className="text-lg font-semibold"
            style={{ color: "#0a1f44" }}
          >
            {mode === "create" ? "New frequency rule" : "Edit frequency rule"}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                value={form.name}
                maxLength={200}
                onChange={(e) => patch("name", e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rule-priority">Priority</Label>
              <Input
                id="rule-priority"
                type="number"
                min={0}
                max={100000}
                value={form.priority}
                onChange={(e) => patch("priority", e.target.value)}
                required
                disabled={isPending}
              />
              <p className="mt-1 text-xs" style={{ color: "#6b7280" }}>
                Lower runs first.
              </p>
            </div>
            <div>
              <Label htmlFor="rule-cadence">Cadence days</Label>
              <Input
                id="rule-cadence"
                type="number"
                min={1}
                max={365}
                value={form.cadenceDays}
                onChange={(e) => patch("cadenceDays", e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rule-channel">Default channel</Label>
              <Select
                id="rule-channel"
                value={form.defaultChannel}
                options={[
                  { value: "sms", label: "SMS" },
                  { value: "email", label: "Email" },
                  { value: "voice", label: "Voice" },
                ]}
                emptyOptionLabel="Use SMS-then-email fallback"
                onChange={(e) =>
                  patch("defaultChannel", e.target.value as ChannelChoice)
                }
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rule-sku">SKU prefix (optional)</Label>
              <Input
                id="rule-sku"
                value={form.matchItemSkuPrefix}
                placeholder="e.g. CPAP-"
                maxLength={120}
                onChange={(e) => patch("matchItemSkuPrefix", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rule-payer">Insurance payer (optional)</Label>
              <Input
                id="rule-payer"
                value={form.matchInsurancePayer}
                placeholder="e.g. Aetna"
                maxLength={120}
                onChange={(e) => patch("matchInsurancePayer", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rule-min-tenure">Min tenure days (optional)</Label>
              <Input
                id="rule-min-tenure"
                type="number"
                min={0}
                max={36500}
                value={form.minTenureDays}
                onChange={(e) => patch("minTenureDays", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rule-max-tenure">Max tenure days (optional)</Label>
              <Input
                id="rule-max-tenure"
                type="number"
                min={0}
                max={36500}
                value={form.maxTenureDays}
                onChange={(e) => patch("maxTenureDays", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="rule-notes">Notes (optional)</Label>
              <textarea
                id="rule-notes"
                value={form.notes}
                onChange={(e) => patch("notes", e.target.value)}
                maxLength={2000}
                rows={3}
                className="block w-full rounded border px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2"
                style={{ borderColor: "#d1d5db", color: "#0a1f44" }}
                disabled={isPending}
              />
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="rule-active"
                type="checkbox"
                checked={form.active}
                onChange={(e) => patch("active", e.target.checked)}
                disabled={isPending}
              />
              <label
                htmlFor="rule-active"
                className="text-sm"
                style={{ color: "#0a1f44" }}
              >
                Active — eligible for matching
              </label>
            </div>
          </div>

          {error && (
            <p
              className="text-sm"
              style={{ color: "#b91c1c" }}
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t" style={{ borderColor: "#e5e7eb" }}>
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
              {mode === "edit" && initial && (
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
    </div>
  );
}
