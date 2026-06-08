// /admin/billing/config/clearinghouse — Office Ally / clearinghouse
// connection editor.
//
// DB-backed SFTP connection + submitter identity (ETIN) the
// identity-resolver prefers over the legacy OFFICE_ALLY_* env vars.
// Manages the primary connection (the practical case is a single Office
// Ally account): edits the existing row or creates the first one, plus a
// Test connection button.
//
// SECURITY: `privateKeyPath` / `knownHostsPath` are FILE PATHS on the
// server (mode 0600) — the key bytes are never stored here or in the DB.
// Provision the key via a Railway volume or a write-at-boot step (see
// docs/runbooks/office-ally-go-live.md).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  type ClearinghouseBody,
  CLEARINGHOUSE_REQUIRED,
  clearinghouseToBody,
  createClearinghouse,
  emptyClearinghouseBody,
  fetchClearinghouses,
  testClearinghouse,
  updateClearinghouse,
} from "@/lib/admin/clearinghouse-credentials-api";

interface FieldDef {
  key: keyof ClearinghouseBody;
  label: string;
  required?: boolean;
  placeholder?: string;
}

const CONNECTION: FieldDef[] = [
  { key: "displayName", label: "Display name", required: true },
  {
    key: "slug",
    label: "Slug (a–z, 0–9, _)",
    required: true,
    placeholder: "office_ally",
  },
  { key: "sftpHost", label: "SFTP host", required: true },
  { key: "sftpUsername", label: "SFTP username", required: true },
  {
    key: "privateKeyPath",
    label: "Private key file path (0600 — not the key itself)",
    required: true,
    placeholder: "/secrets/oa_id_ed25519",
  },
  {
    key: "knownHostsPath",
    label: "known_hosts file path",
    required: true,
    placeholder: "/secrets/oa_known_hosts",
  },
  { key: "remoteInboxDir", label: "Remote inbox dir", placeholder: "inbound" },
  {
    key: "remoteOutboundDir",
    label: "Remote outbound dir",
    placeholder: "outbound",
  },
  { key: "remoteArchiveDir", label: "Remote archive dir (optional)" },
];
const SUBMITTER: FieldDef[] = [
  { key: "etin", label: "ETIN (submitter id)", required: true },
  { key: "submitterOrganizationName", label: "Submitter org name" },
  { key: "contactName", label: "Contact name" },
  {
    key: "contactPhoneE164",
    label: "Contact phone",
    placeholder: "+12155551234",
  },
];
const REALTIME: FieldDef[] = [
  {
    key: "realtimeUrl",
    label: "Endpoint URL (Office Ally /v1/realtime-eligibility/x12)",
    placeholder: "https://edi.officeally.io/v1/realtime-eligibility/x12",
  },
];

const NULLABLE = new Set<keyof ClearinghouseBody>([
  "remoteArchiveDir",
  "submitterOrganizationName",
  "contactName",
  "contactPhoneE164",
  "notes",
  "realtimeUrl",
]);

const INPUT_STYLE = { borderColor: "hsl(var(--line))" } as const;

export function AdminBillingConfigClearinghousePage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "clearinghouse-credentials"],
    queryFn: fetchClearinghouses,
  });

  // Manage the primary (first) connection — create one if none exists.
  const existing = data?.clearinghouses?.[0] ?? null;
  const [body, setBody] = useState<ClearinghouseBody>(emptyClearinghouseBody);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const row = data.clearinghouses?.[0] ?? null;
    setBody(row ? clearinghouseToBody(row) : emptyClearinghouseBody());
  }, [data]);

  const save = useMutation({
    mutationFn: async (b: ClearinghouseBody): Promise<void> => {
      if (existing) {
        await updateClearinghouse(existing.id, b);
      } else {
        await createClearinghouse(b);
      }
    },
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({
        queryKey: ["admin", "clearinghouse-credentials"],
      });
    },
  });

  const test = useMutation({
    mutationFn: () => {
      if (!existing) throw new Error("Save the connection first");
      return testClearinghouse(existing.id);
    },
    onSuccess: (r) =>
      setTestResult(
        r.ok
          ? `Connection OK${typeof r.fileCount === "number" ? ` — ${r.fileCount} file(s) in remote inbox` : ""}`
          : "Connection test returned not-ok",
      ),
    onError: (e) =>
      setTestResult(e instanceof Error ? e.message : "Connection test failed"),
  });

  const missingRequired = useMemo(
    () => CLEARINGHOUSE_REQUIRED.filter((k) => !String(body[k] ?? "").trim()),
    [body],
  );

  const setText = (key: keyof ClearinghouseBody, raw: string): void => {
    setSaved(false);
    setBody((p) => ({
      ...p,
      [key]: raw === "" && NULLABLE.has(key) ? null : raw,
    }));
  };

  if (isPending) {
    return (
      <div className="admin-root p-6">
        <Spinner />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="admin-root p-6">
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  function textField(f: FieldDef) {
    return (
      <label key={String(f.key)} className="block text-sm">
        <span style={{ color: "hsl(var(--ink-2))" }}>
          {f.label}
          {f.required ? <span style={{ color: "#dc2626" }}> *</span> : null}
        </span>
        <input
          type="text"
          className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
          style={INPUT_STYLE}
          value={(body[f.key] as string | null) ?? ""}
          placeholder={f.placeholder}
          onChange={(e) => setText(f.key, e.target.value)}
        />
      </label>
    );
  }

  return (
    <div className="admin-root p-6 space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold">Clearinghouse connection</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          The Office Ally SFTP connection + submitter ETIN used to transmit
          claims (837P) and eligibility (270/271). Saved to the database and
          preferred over the legacy <code>OFFICE_ALLY_*</code> env vars. The key
          fields below are <strong>file paths</strong> to the SSH key /
          known_hosts on the server — the key itself is never stored here. See
          the go-live runbook for provisioning the key file.
        </p>
      </header>

      <Card title="Environment & status">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>Usage indicator</span>
            <select
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={body.usageIndicator}
              onChange={(e) => {
                setSaved(false);
                setBody((p) => ({
                  ...p,
                  usageIndicator: e.target.value === "P" ? "P" : "T",
                }));
              }}
            >
              <option value="T">T — test / sandbox</option>
              <option value="P">P — production (live)</option>
            </select>
          </label>
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>SFTP port</span>
            <input
              type="number"
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={body.sftpPort}
              onChange={(e) => {
                setSaved(false);
                const n = Number.parseInt(e.target.value, 10);
                setBody((p) => ({
                  ...p,
                  sftpPort: Number.isFinite(n) ? n : 22,
                }));
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm mt-1">
            <input
              type="checkbox"
              checked={body.isActive}
              onChange={(e) => {
                setSaved(false);
                setBody((p) => ({ ...p, isActive: e.target.checked }));
              }}
            />
            <span style={{ color: "hsl(var(--ink-2))" }}>
              Active (used by the submit + poll jobs)
            </span>
          </label>
          {existing?.lastPolledAt && (
            <div
              className="text-sm self-center"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Last polled: {new Date(existing.lastPolledAt).toLocaleString()}
            </div>
          )}
        </div>
      </Card>

      <Card title="SFTP connection">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CONNECTION.map(textField)}
        </div>
      </Card>

      <Card title="Submitter identity">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SUBMITTER.map(textField)}
        </div>
      </Card>

      <Card title="Real-time eligibility (270/271)">
        <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
          Optional. When enabled, an eligibility check POSTs the 270 to Office
          Ally&rsquo;s EDI REST API and returns the 271 inline (seconds) instead
          of submitting over SFTP and waiting for the poll (minutes). Enter the
          endpoint and API key below (stored on the connection) or set{" "}
          <code>OFFICE_ALLY_REALTIME_URL</code> +{" "}
          <code>OFFICE_ALLY_REALTIME_API_KEY</code> — the saved key is never
          shown back.
        </p>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input
            type="checkbox"
            checked={body.realtimeEnabled}
            onChange={(e) => {
              setSaved(false);
              setBody((p) => ({ ...p, realtimeEnabled: e.target.checked }));
            }}
          />
          <span style={{ color: "hsl(var(--ink-2))" }}>
            Enabled (use real-time for eligibility)
          </span>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {REALTIME.map(textField)}
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>
              Timeout (ms, default 30000)
            </span>
            <input
              type="number"
              min={1000}
              max={120000}
              step={1000}
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={body.realtimeTimeoutMs ?? ""}
              placeholder="30000"
              onChange={(e) => {
                setSaved(false);
                const raw = e.target.value.trim();
                const n = Number.parseInt(raw, 10);
                setBody((p) => ({
                  ...p,
                  realtimeTimeoutMs:
                    raw === "" || !Number.isFinite(n) ? null : n,
                }));
              }}
            />
          </label>
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>
              API key{" "}
              {existing?.realtimePasswordSet
                ? "(saved — leave blank to keep)"
                : "(or set via env)"}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={body.realtimePassword ?? ""}
              placeholder={
                existing?.realtimePasswordSet ? "•••••••• (unchanged)" : ""
              }
              onChange={(e) => {
                setSaved(false);
                const v = e.target.value;
                setBody((p) => ({
                  ...p,
                  realtimePassword: v === "" ? null : v,
                }));
              }}
            />
          </label>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: "hsl(var(--penn-navy))" }}
          disabled={save.isPending || missingRequired.length > 0}
          onClick={() => save.mutate(body)}
        >
          {save.isPending
            ? "Saving…"
            : existing
              ? "Save connection"
              : "Create connection"}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={INPUT_STYLE}
          disabled={!existing || test.isPending}
          onClick={() => {
            setTestResult(null);
            test.mutate();
          }}
          title={
            existing ? "Test the SFTP connection" : "Save the connection first"
          }
        >
          <PlugZap className="h-4 w-4" />
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
        {missingRequired.length > 0 && (
          <span className="text-sm" style={{ color: "#b45309" }}>
            Fill required fields: {missingRequired.join(", ")}
          </span>
        )}
        {saved && !save.isPending && (
          <span className="text-sm" style={{ color: "#15803d" }}>
            Saved.
          </span>
        )}
        {save.isError && (
          <span className="text-sm" style={{ color: "#dc2626" }}>
            {save.error instanceof Error ? save.error.message : "Save failed"}
          </span>
        )}
        {testResult && (
          <span
            className="text-sm"
            style={{
              color: test.isError ? "#dc2626" : "#15803d",
            }}
          >
            {testResult}
          </span>
        )}
      </div>
    </div>
  );
}

export default AdminBillingConfigClearinghousePage;
