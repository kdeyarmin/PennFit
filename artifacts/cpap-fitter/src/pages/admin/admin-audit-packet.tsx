// /admin/audit-packet — the audit packet creator ("run the report").
//
// Reached with ?patientId=…&adrId=…&claimId=…&scope=… (e.g. from the ADR
// worklist's "Build packet" link). Loads the CPAP/PAP audit-document catalog,
// pre-checks the right items for the audit scope, lets the operator toggle
// what to include, and generates ONE combined PDF — stored chart documents +
// system-generated summaries — to hand to the auditor. Reports which selected
// items had nothing on file so gaps are visible before sending.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  type AdrScope,
  type AuditCatalogItem,
  buildAuditPacket,
  downloadHistoricalPacket,
  faxAuditPacket,
  getAuditPacketCatalog,
  getAuditPacketHistory,
  getAuditReadiness,
} from "@/lib/admin/adr-api";

const SCOPES: AdrScope[] = ["device", "supplies", "both"];
const GROUP_LABELS: Record<string, string> = {
  cover: "Cover",
  order: "Order / prescription",
  clinical: "Clinical / medical necessity",
  adherence: "Adherence",
  delivery: "Delivery & equipment",
  authorization: "Authorization & coverage",
  supplies: "Supplies / resupply",
  billing: "Billing",
};

function readParams(): {
  patientId: string;
  adrId: string | null;
  claimId: string | null;
  scope: AdrScope;
} {
  const p = new URLSearchParams(window.location.search);
  const scope = p.get("scope");
  return {
    patientId: p.get("patientId") ?? "",
    adrId: p.get("adrId"),
    claimId: p.get("claimId"),
    scope: scope === "supplies" || scope === "both" ? scope : "device",
  };
}

export function AdminAuditPacketPage() {
  const params = useMemo(readParams, []);
  const [scope, setScope] = useState<AdrScope>(params.scope);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<{
    pages: number;
    missing: string[];
    packetId: string | null;
  } | null>(null);
  const [buildError, setBuildError] = useState(false);
  const [faxNumber, setFaxNumber] = useState("");
  const [faxState, setFaxState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");

  const catalogQuery = useQuery({
    queryKey: ["admin", "audit-packet-catalog"] as const,
    queryFn: getAuditPacketCatalog,
    staleTime: 5 * 60_000,
  });

  // Proactive audit-readiness for this patient + scope: which audit-critical
  // documents are on file vs missing.
  const readinessQuery = useQuery({
    queryKey: ["admin", "audit-readiness", params.patientId, scope] as const,
    queryFn: () => getAuditReadiness(params.patientId, scope),
    enabled: !!params.patientId,
    staleTime: 60_000,
  });

  const qc = useQueryClient();
  const historyQuery = useQuery({
    queryKey: ["admin", "audit-packets", params.patientId] as const,
    queryFn: () => getAuditPacketHistory(params.patientId),
    enabled: !!params.patientId,
    staleTime: 30_000,
  });

  // Initialise / reset the selection to the scope's defaults when the catalog
  // loads or the scope changes.
  useEffect(() => {
    if (!catalogQuery.data) return;
    setSelected(new Set(catalogQuery.data.defaults[scope]));
  }, [catalogQuery.data, scope]);

  const labelFor = (key: string): string =>
    catalogQuery.data?.items.find((i) => i.key === key)?.label ?? key;

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function generate(): Promise<void> {
    setBuilding(true);
    setBuildError(false);
    setResult(null);
    try {
      const res = await buildAuditPacket(params.patientId, {
        scope,
        selectedKeys: [...selected],
        adrId: params.adrId,
        claimId: params.claimId,
      });
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setResult({
        pages: res.pages,
        missing: res.missing,
        packetId: res.packetId,
      });
      setFaxState("idle");
      void qc.invalidateQueries({
        queryKey: ["admin", "audit-packets", params.patientId],
      });
    } catch {
      setBuildError(true);
    } finally {
      setBuilding(false);
    }
  }

  if (!params.patientId) {
    return (
      <div className="admin-root p-6 max-w-3xl">
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            Open this from a patient or from an ADR's “Build packet” link — a
            patient is required to assemble an audit packet.
          </p>
        </Card>
      </div>
    );
  }

  const grouped = groupItems(catalogQuery.data?.items ?? []);

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-audit-packet-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileText className="h-6 w-6" />
          Audit packet
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Choose what to include and generate one combined PDF for the auditor —
          stored documents plus summaries generated from the records already in
          the system.
        </p>
      </header>

      <div className="flex items-center gap-2 text-sm">
        <span style={{ color: "hsl(var(--ink-3))" }}>Audit type:</span>
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            className="rounded border px-3 py-1"
            style={{
              borderColor:
                s === scope ? "hsl(var(--penn-navy))" : "hsl(var(--line-1))",
              background: s === scope ? "hsl(var(--penn-navy) / 0.08)" : "",
            }}
            onClick={() => setScope(s)}
          >
            {s === "device"
              ? "PAP device"
              : s === "supplies"
                ? "Supplies"
                : "Both"}
          </button>
        ))}
      </div>

      {readinessQuery.data ? (
        <ReadinessBanner data={readinessQuery.data} />
      ) : null}

      {catalogQuery.isPending ? (
        <Spinner label="Loading audit checklist…" />
      ) : catalogQuery.isError ? (
        <ErrorPanel
          error={catalogQuery.error}
          onRetry={() => void catalogQuery.refetch()}
        />
      ) : (
        <>
          {grouped.map(([group, items]) => (
            <Card key={group} title={GROUP_LABELS[group] ?? group}>
              <div className="space-y-2">
                {items.map((item) => (
                  <label
                    key={item.key}
                    className="flex items-start gap-3 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(item.key)}
                      onChange={() => toggle(item.key)}
                    />
                    <span className="flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {item.label}
                        <SourceBadge source={item.source} />
                      </span>
                      <span
                        className="block text-xs mt-0.5"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {item.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </Card>
          ))}

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-sm rounded px-4 py-2 text-white disabled:opacity-50"
              style={{ background: "hsl(var(--penn-navy))" }}
              disabled={selected.size === 0 || building}
              onClick={() => void generate()}
            >
              {building ? "Generating…" : `Generate packet (${selected.size})`}
            </button>
            {buildError ? (
              <span className="text-sm" style={{ color: "hsl(354 75% 38%)" }}>
                Could not generate the packet. Please try again.
              </span>
            ) : null}
          </div>

          {result ? (
            <Card title="Packet generated">
              <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
                Downloaded a {result.pages}-page PDF.
              </p>
              {result.missing.length > 0 ? (
                <div className="mt-2">
                  <p className="text-sm" style={{ color: "hsl(38 80% 28%)" }}>
                    {result.missing.length} selected item
                    {result.missing.length === 1 ? "" : "s"} had no document on
                    file and {result.missing.length === 1 ? "was" : "were"} not
                    included:
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {result.missing.map((key) => (
                      <Badge key={key} variant="warning">
                        {labelFor(key)}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : (
                <p
                  className="text-sm mt-1"
                  style={{ color: "hsl(152 70% 24%)" }}
                >
                  All selected items were included.
                </p>
              )}

              {result.packetId ? (
                <div
                  className="mt-3 pt-3 border-t"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <p
                    className="text-sm font-medium mb-1.5"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    Fax to contractor
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      className="rounded border px-2 py-1.5 text-sm"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                      placeholder="+15551234567"
                      value={faxNumber}
                      onChange={(e) => setFaxNumber(e.target.value)}
                    />
                    <button
                      type="button"
                      className="text-sm rounded px-3 py-1.5 text-white disabled:opacity-50"
                      style={{ background: "hsl(var(--penn-navy))" }}
                      disabled={
                        !/^\+[1-9]\d{6,14}$/.test(faxNumber.trim()) ||
                        faxState === "sending"
                      }
                      onClick={() => void sendFax(result.packetId!)}
                    >
                      {faxState === "sending" ? "Faxing…" : "Send fax"}
                    </button>
                    {faxState === "sent" ? (
                      <span
                        className="text-sm"
                        style={{ color: "hsl(152 70% 24%)" }}
                      >
                        Faxed — ADR marked submitted.
                      </span>
                    ) : null}
                    {faxState === "error" ? (
                      <span
                        className="text-sm"
                        style={{ color: "hsl(354 75% 38%)" }}
                      >
                        Fax failed (check fax setup / number).
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Card>
          ) : null}

          {historyQuery.data && historyQuery.data.packets.length > 0 ? (
            <Card title="Recent packets">
              <div className="space-y-1.5">
                {historyQuery.data.packets.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span style={{ color: "hsl(var(--ink-3))" }}>
                      {new Date(p.generated_at).toLocaleString()} · {p.scope} ·{" "}
                      {p.item_count} items
                      {p.page_count ? ` · ${p.page_count}p` : ""}
                    </span>
                    {p.object_key ? (
                      <button
                        type="button"
                        className="underline"
                        style={{ color: "hsl(var(--penn-navy))" }}
                        onClick={() => void redownload(p.id)}
                      >
                        Download
                      </button>
                    ) : (
                      <span
                        className="text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        not stored
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );

  async function sendFax(packetId: string): Promise<void> {
    setFaxState("sending");
    try {
      await faxAuditPacket(packetId, faxNumber.trim());
      setFaxState("sent");
    } catch {
      setFaxState("error");
    }
  }

  async function redownload(packetId: string): Promise<void> {
    const blob = await downloadHistoricalPacket(packetId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-packet-${packetId.slice(0, 8)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

function ReadinessBanner({
  data,
}: {
  data: import("@/lib/admin/adr-api").AuditReadiness;
}) {
  const { readiness } = data;
  const pct = Math.round(readiness.score * 100);
  const tone = readiness.ready
    ? { fg: "hsl(152 70% 24%)", bg: "hsl(152 60% 38% / 0.10)" }
    : { fg: "hsl(38 80% 28%)", bg: "hsl(38 95% 48% / 0.10)" };
  const missingLabels = data.items
    .filter((i) => !i.present)
    .map((i) => i.label);
  return (
    <div
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-1))", background: tone.bg }}
      data-testid="audit-readiness"
    >
      <p className="text-sm font-medium" style={{ color: tone.fg }}>
        {readiness.ready
          ? `Audit ready — all ${readiness.required.length} required documents on file (${pct}%).`
          : `Audit readiness ${pct}% — ${readiness.present.length} of ${readiness.required.length} required documents on file.`}
      </p>
      {missingLabels.length > 0 ? (
        <div className="mt-1.5">
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Missing required:
          </span>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {missingLabels.map((label) => (
              <Badge key={label} variant="warning">
                {label}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SourceBadge({ source }: { source: AuditCatalogItem["source"] }) {
  if (source === "generated") return <Badge variant="info">generated</Badge>;
  if (source === "hybrid")
    return <Badge variant="neutral">on file / generated</Badge>;
  return <Badge variant="neutral">on file</Badge>;
}

function groupItems(
  items: AuditCatalogItem[],
): Array<[string, AuditCatalogItem[]]> {
  const order = [
    "cover",
    "order",
    "clinical",
    "adherence",
    "delivery",
    "authorization",
    "supplies",
    "billing",
  ];
  const map = new Map<string, AuditCatalogItem[]>();
  for (const item of items) {
    const arr = map.get(item.group) ?? [];
    arr.push(item);
    map.set(item.group, arr);
  }
  return order
    .filter((g) => map.has(g))
    .map((g) => [g, map.get(g)!] as [string, AuditCatalogItem[]]);
}
