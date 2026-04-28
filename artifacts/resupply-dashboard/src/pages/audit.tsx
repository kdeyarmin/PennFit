import { useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getListAuditQueryKey,
  useListAudit,
  type ListAuditParams,
} from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Pagination } from "../components/Pagination";
import { Input, Label, Select } from "../components/Input";
import { Button } from "../components/Button";
import { formatDateTime } from "../lib/format";

const PAGE_SIZE = 25;

// Audit metadata is written through @workspace/resupply-audit's
// sanitiser, which denies a PHI key list (firstName, lastName,
// phoneE164, body, …) and caps depth + size. As a defence-in-depth
// measure the dashboard renderer only displays an explicit allowlist
// of keys; anything else is summarised as "<n> additional fields"
// rather than dumped into the DOM. This way an audit row that
// somehow carried a renamed PHI field — for example a future
// @action that writes `metadata.first_name` instead of `firstName`
// — still doesn't surface in the UI.

const DISPLAY_KEY_ALLOWLIST: ReadonlyArray<string> = [
  "source",
  "channel",
  "status",
  "messageCount",
  "messageId",
  "messageSid",
  "callSid",
  "conversationId",
  "patientId",
  "episodeId",
  "prescriptionId",
  "fulfillmentId",
  "reason",
  "outcome",
  "deliveryStatus",
  "errorCode",
  "templateName",
  "duration",
  "count",
];

// Common target_table values seen in production. Free text is allowed
// because the schema is `varchar` and new tables show up over time;
// the dropdown here is just a convenience for the most common picks.
const TARGET_TABLE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "patients", label: "patients" },
  { value: "episodes", label: "episodes" },
  { value: "conversations", label: "conversations" },
  { value: "messages", label: "messages" },
  { value: "fulfillments", label: "fulfillments" },
  { value: "prescriptions", label: "prescriptions" },
];

type Row = {
  id: string;
  occurredAt: string;
  operatorEmail?: string | null;
  action: string;
  targetTable?: string | null;
  targetId?: string | null;
  metadata: { [key: string]: unknown };
};

export function AuditPage() {
  const [actionInput, setActionInput] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [targetTable, setTargetTable] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);

  // Debounce the action substring so live-typing doesn't re-issue
  // the query after every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setAction(actionInput.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [actionInput]);

  useEffect(() => {
    setOffset(0);
  }, [targetTable, since]);

  const params: ListAuditParams = useMemo(
    () => ({
      ...(action ? { action } : {}),
      ...(targetTable ? { targetTable } : {}),
      ...(since ? { since: toIso(since) ?? since } : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [action, targetTable, since, offset],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListAudit(params, {
      query: {
        queryKey: getListAuditQueryKey(params),
        placeholderData: keepPreviousData,
      },
    });

  const cols: Column<Row>[] = [
    {
      key: "occurred",
      header: "When",
      render: (r) => (
        <span className="text-xs whitespace-nowrap" style={{ color: "#374151" }}>
          {formatDateTime(r.occurredAt)}
        </span>
      ),
    },
    {
      key: "operator",
      header: "Operator",
      render: (r) => (
        <span className="text-xs" style={{ color: "#0a1f44" }}>
          {r.operatorEmail ?? "—"}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (r) => (
        <code
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ backgroundColor: "#f1f5f9", color: "#0a1f44" }}
        >
          {r.action}
        </code>
      ),
    },
    {
      key: "target",
      header: "Target",
      render: (r) =>
        r.targetTable ? (
          <span className="text-xs" style={{ color: "#374151" }}>
            <code>{r.targetTable}</code>
            {r.targetId && (
              <span className="text-[10px] block" style={{ color: "#6b7280" }}>
                {r.targetId.slice(0, 8)}…
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs" style={{ color: "#9ca3af" }}>
            —
          </span>
        ),
    },
    {
      key: "metadata",
      header: "Context",
      render: (r) => <SafeMetadata metadata={r.metadata} />,
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "#0a1f44" }}
        >
          Audit log
        </h1>
        <p className="text-sm" style={{ color: "#374151" }}>
          Operator-visible action history. Only allowlisted metadata keys are
          rendered to prevent accidental PHI surface.
        </p>
      </header>

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <Label htmlFor="audit-action">Action contains</Label>
            <Input
              id="audit-action"
              type="search"
              placeholder="e.g. patient.view"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="audit-table">Target table</Label>
            <Select
              id="audit-table"
              value={targetTable}
              emptyOptionLabel="All tables"
              options={TARGET_TABLE_OPTIONS}
              onChange={(e) => setTargetTable(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="audit-since">Since</Label>
            <Input
              id="audit-since"
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                setActionInput("");
                setAction("");
                setTargetTable("");
                setSince("");
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading audit rows…" />
          ) : (
            <>
              <Table
                columns={cols}
                rows={data.items}
                rowKey={(r) => r.id}
                emptyState={
                  <EmptyState
                    title="No audit rows match this filter."
                    hint="Widen the time range or clear filters."
                  />
                }
              />
              <Pagination
                total={data.total}
                limit={data.limit}
                offset={data.offset}
                onChange={setOffset}
                isLoading={isFetching}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}

// PHI-defence renderer for audit metadata. Renders ONLY allowlisted
// keys with a primitive-coercion safe path (string, number, boolean).
// Unknown keys are summarised by count to keep the renderer
// transparent without leaking values.

export function SafeMetadata({
  metadata,
}: {
  metadata: { [key: string]: unknown };
}) {
  const entries = Object.entries(metadata ?? {});
  const visible = entries.filter(([k]) => DISPLAY_KEY_ALLOWLIST.includes(k));
  const hiddenCount = entries.length - visible.length;

  if (visible.length === 0 && hiddenCount === 0) {
    return (
      <span className="text-xs" style={{ color: "#9ca3af" }}>
        —
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map(([k, v]) => (
        <span
          key={k}
          className="text-[10px] px-1.5 py-0.5 rounded border"
          style={{
            backgroundColor: "#f8fafc",
            borderColor: "#e5e7eb",
            color: "#0a1f44",
          }}
        >
          <span style={{ color: "#6b7280" }}>{k}</span>={renderPrimitive(v)}
        </span>
      ))}
      {hiddenCount > 0 && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{ backgroundColor: "#f1f5f9", color: "#6b7280" }}
          title="Hidden by allowlist"
        >
          +{hiddenCount} hidden
        </span>
      )}
    </div>
  );
}

function renderPrimitive(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 32 ? value.slice(0, 32) + "…" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Object / array / other: don't render — would risk leaking nested
  // PHI keys that the sanitiser caught only at the top level.
  return "[object]";
}

function toIso(localDateTime: string): string | null {
  if (!localDateTime) return null;
  const d = new Date(localDateTime);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
