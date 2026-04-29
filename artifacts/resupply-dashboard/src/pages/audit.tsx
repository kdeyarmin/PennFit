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
import { downloadAuditExport } from "../lib/audit-export";

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
  adminEmail?: string | null;
  action: string;
  targetTable?: string | null;
  targetId?: string | null;
  metadata: { [key: string]: unknown };
};

// Categorise an audit row by its action prefix so the renderer can
// visually distinguish PHI-touching rows ("patient.view",
// "conversation.read", anything that surfaced PHI to a human) from
// system events (cron dispatchers, message-status callbacks,
// inventory mutations, etc).
//
// PHI rows get a left rule + slightly tinted background so a
// reviewer sweeping the log can scan for "who looked at what" at a
// glance without reading every action name.
//
// Anything that doesn't match the PHI prefix list is treated as
// "system" — we err toward NOT decorating rather than mis-flagging
// a system action as PHI. Add to PHI_PREFIXES as new PHI-touching
// actions ship.
const PHI_PREFIXES: ReadonlyArray<string> = [
  "patient.",
  "patients.",
  "conversation.",
  "conversations.",
  "episode.",
  "episodes.",
  "prescription.",
  "prescriptions.",
  "fulfillment.",
  "fulfillments.",
  "message.",
  "messages.",
];

function isPhiAction(action: string): boolean {
  const a = action.toLowerCase();
  return PHI_PREFIXES.some((p) => a.startsWith(p));
}

type ExportPhase =
  | { kind: "idle" }
  | { kind: "downloading" }
  | { kind: "done"; filename: string }
  | { kind: "error"; message: string };

export function AuditPage() {
  const [actionInput, setActionInput] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [targetTable, setTargetTable] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);
  const [exportPhase, setExportPhase] = useState<ExportPhase>({ kind: "idle" });

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
      key: "admin",
      header: "Admin",
      render: (r) => (
        <span className="text-xs" style={{ color: "#0a1f44" }}>
          {r.adminEmail ?? "—"}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (r) => {
        const phi = isPhiAction(r.action);
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            {phi && (
              <span
                className="text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded"
                style={{
                  backgroundColor: "#fef3c7",
                  color: "#854d0e",
                  border: "1px solid #fde68a",
                }}
                title="This action read or wrote patient information"
                data-testid={`audit-phi-tag-${r.id}`}
              >
                PHI
              </span>
            )}
            <code
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: phi ? "#fffbeb" : "#f1f5f9",
                color: "#0a1f44",
                border: phi ? "1px solid #fde68a" : "1px solid transparent",
              }}
            >
              {r.action}
            </code>
          </div>
        );
      },
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
          Admin-visible action history. Only allowlisted metadata keys are
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
          <div className="flex items-end gap-2">
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
            <Button
              intent="secondary"
              size="sm"
              data-testid="audit-export-csv-button"
              disabled={exportPhase.kind === "downloading"}
              onClick={async () => {
                setExportPhase({ kind: "downloading" });
                try {
                  const r = await downloadAuditExport({
                    ...(action ? { action } : {}),
                    ...(targetTable ? { targetTable } : {}),
                    ...(since ? { since: toIso(since) ?? since } : {}),
                  });
                  setExportPhase({ kind: "done", filename: r.filename });
                  // Auto-clear the success state after a few seconds
                  // so the button reverts to its idle label.
                  setTimeout(() => setExportPhase({ kind: "idle" }), 4000);
                } catch (err) {
                  setExportPhase({
                    kind: "error",
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              }}
            >
              {exportPhase.kind === "downloading"
                ? "Preparing CSV…"
                : exportPhase.kind === "done"
                  ? "Downloaded ✓"
                  : "Export CSV"}
            </Button>
          </div>
        </div>
        {exportPhase.kind === "error" && (
          <div
            className="mt-3 text-xs px-3 py-2 rounded"
            style={{
              backgroundColor: "#fef2f2",
              color: "#991b1b",
              border: "1px solid #fecaca",
            }}
            data-testid="audit-export-error"
          >
            Couldn't download: {exportPhase.message}
          </div>
        )}
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
