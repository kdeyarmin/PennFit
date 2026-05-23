// /admin/inbound-referrals — CSR triage queue for inbound electronic
// DME orders (Parachute Health + EHR FHIR partners).
//
// Mirrors the inbound-faxes page shape:
//   - Header with status-filter chips
//   - Table of referrals (received, source, status pill, AI confidence,
//     matchers)
//   - Detail modal with collapsible sections:
//       Overview | Pre-flight | Status callbacks | Share links | Triage
//
// State machine + permissions are enforced on the server; this page
// is permissive on form input — the API returns 400 with the issue
// when a transition is invalid.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  Inbox,
  Loader2,
  RefreshCw,
  Share2,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { useUrlState } from "@/hooks/use-url-state";
import {
  acceptInboundReferral,
  getInboundReferral,
  getSuggestedPatients,
  listInboundReferrals,
  mintShareToken,
  patchInboundReferral,
  resendStatus,
  revokeShareToken,
  runPreflight,
  type PreflightOutcomeStatus,
  type ReferralLifecycleEvent,
  type ReferralListFilter,
  type ReferralListItem,
  type ReferralPreflightCheck,
  type ReferralStatusCallback,
  type ReferralShareToken,
  type ReferralTriageStatus,
  type SuggestedPatient,
} from "@/lib/admin/inbound-referrals-api";

const FILTER_IDS: ReadonlySet<string> = new Set<ReferralListFilter>([
  "open",
  "new",
  "triaged",
  "accepted",
  "rejected",
  "duplicate",
  "archived",
]);
const isFilter = (v: string): v is ReferralListFilter => FILTER_IDS.has(v);

const queryKey = (f: ReferralListFilter) =>
  ["admin", "inbound-referrals", f] as const;
const detailKey = (id: string) =>
  ["admin", "inbound-referrals", "detail", id] as const;
const suggestedKey = (id: string) =>
  ["admin", "inbound-referrals", "suggested-patients", id] as const;

export function AdminInboundReferralsPage() {
  const [filter, setFilter] = useUrlState<ReferralListFilter>({
    key: "filter",
    defaultValue: "open",
    isAllowed: isFilter,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKey(filter),
    queryFn: () => listInboundReferrals(filter),
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Inbox className="h-6 w-6" />
          Inbound referrals
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Electronic DME orders landed from Parachute Health and connected
          EHR partners. Auto-matched to the patient + provider where we
          can, AI-classified by intent, and pre-flighted for payer PA,
          eligibility, and doc gaps.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            "open",
            "new",
            "triaged",
            "accepted",
            "rejected",
            "duplicate",
            "archived",
          ] as const
        ).map((f) => (
          <FilterChip
            key={f}
            label={
              f === "open"
                ? "Open queue"
                : f.charAt(0).toUpperCase() + f.slice(1)
            }
            active={filter === f}
            onClick={() => setFilter(f)}
          />
        ))}
      </div>

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.referrals.length === 0 ? (
          <p
            className="text-sm py-3"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            No referrals in this view.
          </p>
        ) : (
          <ReferralTable rows={data.referrals} onSelect={setSelectedId} />
        )}
      </Card>

      {selectedId && (
        <DetailModal
          referralId={selectedId}
          onClose={() => setSelectedId(null)}
          listFilter={filter}
        />
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
      style={{
        backgroundColor: active
          ? "hsl(var(--penn-gold))"
          : "hsl(var(--line-2))",
        color: active ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
      }}
    >
      {label}
    </button>
  );
}

const STATUS_COLOR: Record<ReferralTriageStatus, string> = {
  new: "bg-amber-100 text-amber-900",
  triaged: "bg-blue-100 text-blue-900",
  accepted: "bg-emerald-100 text-emerald-900",
  rejected: "bg-rose-100 text-rose-900",
  duplicate: "bg-gray-100 text-gray-700",
  archived: "bg-gray-100 text-gray-700",
};

function ReferralTable({
  rows,
  onSelect,
}: {
  rows: ReferralListItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Received</th>
          <th className="py-2 font-semibold">Source</th>
          <th className="py-2 font-semibold">Order #</th>
          <th className="py-2 font-semibold">Status</th>
          <th className="py-2 font-semibold">AI</th>
          <th className="py-2 font-semibold">Matches</th>
          <th className="py-2 font-semibold">Payer</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const received = new Date(r.receivedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          return (
            <tr
              key={r.id}
              className="border-b cursor-pointer hover:bg-[hsl(var(--bg-2))]"
              style={{ borderColor: "hsl(var(--line-2))" }}
              onClick={() => onSelect(r.id)}
            >
              <td className="py-2">{received}</td>
              <td className="py-2 text-xs font-mono">{r.source}</td>
              <td className="py-2 text-xs font-mono">{r.sourceOrderId}</td>
              <td className="py-2">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[r.triageStatus]}`}
                >
                  {r.triageStatus}
                </span>
              </td>
              <td className="py-2 text-xs tabular-nums">
                {r.aiConfidence !== null
                  ? `${Math.round(r.aiConfidence * 100)}%`
                  : "—"}
              </td>
              <td className="py-2 text-xs">
                {(r.patientMatchId ? "👤" : "·")} {(r.providerMatchId ? "🏥" : "·")}
              </td>
              <td
                className="py-2 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {r.payerName ?? "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ────────────────────────────────────────────────────────────────────
// Detail modal
// ────────────────────────────────────────────────────────────────────

function DetailModal({
  referralId,
  onClose,
  listFilter,
}: {
  referralId: string;
  onClose: () => void;
  listFilter: ReferralListFilter;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: detailKey(referralId),
    queryFn: () => getInboundReferral(referralId),
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: detailKey(referralId) });
    void qc.invalidateQueries({ queryKey: queryKey(listFilter) });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-5xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          {detail.isPending ? (
            <Spinner />
          ) : detail.isError ? (
            <ErrorPanel
              error={detail.error}
              onRetry={() => void detail.refetch()}
            />
          ) : (
            <>
              <ModalHeader referral={detail.data} onClose={onClose} />

              <Section title="Overview">
                <OverviewPane referral={detail.data} />
              </Section>

              <Section title="Patient match" defaultOpen>
                <PatientMatchPane
                  referralId={referralId}
                  current={detail.data.patientMatchId}
                  onSaved={invalidate}
                />
              </Section>

              <Section title="Pre-flight">
                <PreflightPane
                  referralId={referralId}
                  preflightCompletedAt={detail.data.preflightCompletedAt}
                  checks={detail.data.preflightChecks}
                  onRan={invalidate}
                />
              </Section>

              <Section title="Status callbacks">
                <CallbacksPane
                  referralId={referralId}
                  callbacks={detail.data.statusCallbacks}
                  onResent={invalidate}
                />
              </Section>

              <Section title="Clinician share links">
                <ShareTokensPane
                  referralId={referralId}
                  tokens={detail.data.shareTokens}
                  onChanged={invalidate}
                />
              </Section>

              <Section title="Accept" defaultOpen={detail.data.triageStatus !== "accepted"}>
                <AcceptPane
                  referralId={referralId}
                  referral={detail.data}
                  onAccepted={() => {
                    invalidate();
                    onClose();
                  }}
                />
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ModalHeader({
  referral,
  onClose,
}: {
  referral: { sourceOrderId: string; source: string; triageStatus: ReferralTriageStatus };
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "hsl(var(--line-1))" }}>
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
          Referral {referral.sourceOrderId}
        </h2>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          via <span className="font-mono">{referral.source}</span> ·{" "}
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[referral.triageStatus]}`}
          >
            {referral.triageStatus}
          </span>
        </p>
      </div>
      <Button intent="ghost" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="border rounded" open={defaultOpen} style={{ borderColor: "hsl(var(--line-1))" }}>
      <summary
        className="cursor-pointer select-none px-3 py-2 text-sm font-semibold"
        style={{ backgroundColor: "hsl(var(--bg-2))" }}
      >
        {title}
      </summary>
      <div className="px-3 py-3 space-y-3">{children}</div>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────
// Overview pane
// ────────────────────────────────────────────────────────────────────

function OverviewPane({
  referral,
}: {
  referral: {
    aiClassification: import("@/lib/admin/inbound-referrals-api").ReferralAiClassification | null;
    aiConfidence: number | null;
    payerName: string | null;
    orderingNpi: string | null;
    receivedAt: string;
    triagedAt: string | null;
    acceptedAt: string | null;
    documents: Array<{ id: string; kind: string; filename: string | null; sourceUrl: string | null }>;
    hcpcsItems: unknown;
    icd10Codes: unknown;
  };
}) {
  const hcpcs = Array.isArray(referral.hcpcsItems) ? referral.hcpcsItems : [];
  const icd10 = Array.isArray(referral.icd10Codes) ? referral.icd10Codes : [];
  return (
    <div className="grid grid-cols-2 gap-4 text-sm">
      <div className="space-y-2">
        <KV label="Received" value={new Date(referral.receivedAt).toLocaleString()} />
        <KV label="Triaged" value={referral.triagedAt ? new Date(referral.triagedAt).toLocaleString() : "—"} />
        <KV label="Accepted" value={referral.acceptedAt ? new Date(referral.acceptedAt).toLocaleString() : "—"} />
        <KV label="Payer" value={referral.payerName ?? "—"} />
        <KV label="Ordering NPI" value={referral.orderingNpi ?? "—"} />
      </div>
      <div className="space-y-2">
        {referral.aiClassification && (
          <div className="rounded border p-2 text-xs" style={{ borderColor: "hsl(var(--line-1))" }}>
            <div className="font-semibold mb-1">
              AI: {referral.aiClassification.intent} ·{" "}
              {referral.aiConfidence !== null
                ? `${Math.round(referral.aiConfidence * 100)}%`
                : ""}
            </div>
            <div className="mb-1">{referral.aiClassification.summary}</div>
            {referral.aiClassification.flags.length > 0 && (
              <ul className="list-disc list-inside" style={{ color: "hsl(var(--ink-3))" }}>
                {referral.aiClassification.flags.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <KV
          label="HCPCS"
          value={
            hcpcs.length === 0
              ? "—"
              : hcpcs
                  .map((h) => {
                    const obj = h as { code?: string; quantity?: number };
                    return `${obj.code ?? "?"}×${obj.quantity ?? 1}`;
                  })
                  .join(", ")
          }
        />
        <KV label="ICD-10" value={icd10.length === 0 ? "—" : (icd10 as string[]).join(", ")} />
        <KV
          label="Documents"
          value={
            referral.documents.length === 0
              ? "—"
              : `${referral.documents.length} attachment(s)`
          }
        />
        {referral.documents.length > 0 && (
          <ul className="text-xs space-y-1">
            {referral.documents.map((d) => {
              // Defense-in-depth: the partner-API parser already
              // validates http(s)-only on inbound, but a stale row
              // from before that fix (or a future regression there)
              // could still carry a javascript:/data: URL that the
              // admin's session would execute on click. Re-validate
              // here and drop the link if the protocol isn't http(s);
              // rel="noopener noreferrer" does NOT block javascript:.
              const safeUrl = isSafeExternalUrl(d.sourceUrl);
              return (
                <li key={d.id}>
                  <span className="font-mono">{d.kind}</span>{" "}
                  {d.filename && <span>· {d.filename}</span>}
                  {safeUrl && (
                    <a
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 inline-flex items-center gap-1 text-[hsl(var(--penn-navy))] hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="font-semibold w-24" style={{ color: "hsl(var(--penn-navy))" }}>
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

// Defense-in-depth URL validator. The Parachute parse-order.ts schema
// already rejects non-http(s) URLs at intake, but we re-check at the
// render boundary so a future regression in the parser (or a stale
// row from before that fix landed) can't still smuggle a
// javascript:/data:/vbscript: URL into an admin's <a href> — those
// run JS in the admin-session origin on click, and `noopener
// noreferrer` does not block them.
function isSafeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Patient match pane
// ────────────────────────────────────────────────────────────────────

function PatientMatchPane({
  referralId,
  current,
  onSaved,
}: {
  referralId: string;
  current: string | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const sugg = useQuery({
    queryKey: suggestedKey(referralId),
    queryFn: () => getSuggestedPatients(referralId),
    enabled: current === null,
  });
  const save = useMutation({
    mutationFn: () =>
      patchInboundReferral(referralId, {
        patientMatchId: draft.trim() || null,
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (e: Error) => setError(e.message),
  });
  function isUuidOrEmpty(s: string): boolean {
    return s === "" || /^[0-9a-f-]{36}$/i.test(s.trim());
  }
  const valid = isUuidOrEmpty(draft);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="text-xs font-semibold block mb-1" style={{ color: "hsl(var(--penn-navy))" }}>
            Patient ID (UUID)
          </label>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="copy from /admin/patients"
            style={{ borderColor: valid ? undefined : "#dc2626" }}
          />
          {!valid && (
            <p className="text-[10px] text-rose-700 mt-1">Must be a UUID or empty.</p>
          )}
        </div>
        <Button
          intent="secondary"
          disabled={save.isPending || !valid}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Save match
        </Button>
      </div>
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          {error}
        </div>
      )}
      {current === null && sugg.data && sugg.data.candidates.length > 0 && (
        <div>
          <p className="text-xs font-semibold mb-1" style={{ color: "hsl(var(--penn-navy))" }}>
            Suggested patients ({sugg.data.candidates.length})
          </p>
          <ul className="space-y-1 text-xs">
            {sugg.data.candidates.map((p: SuggestedPatient) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded border px-2 py-1"
                style={{ borderColor: "hsl(var(--line-2))" }}
              >
                <span>
                  <span className="font-mono text-[10px]">{p.kind}</span>{" "}
                  <span>
                    {p.legalFirstName ?? ""} {p.legalLastName ?? ""}
                  </span>{" "}
                  <span style={{ color: "hsl(var(--ink-3))" }}>{p.phoneE164 ?? ""}</span>
                </span>
                <button
                  type="button"
                  className="text-[hsl(var(--penn-navy))] hover:underline"
                  onClick={() => setDraft(p.id)}
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Pre-flight pane
// ────────────────────────────────────────────────────────────────────

const PREFLIGHT_BADGE: Record<PreflightOutcomeStatus, string> = {
  info: "bg-gray-100 text-gray-700",
  ok: "bg-emerald-100 text-emerald-900",
  warn: "bg-amber-100 text-amber-900",
  error: "bg-rose-100 text-rose-900",
  skipped: "bg-gray-100 text-gray-700",
};

function PreflightPane({
  referralId,
  preflightCompletedAt,
  checks,
  onRan,
}: {
  referralId: string;
  preflightCompletedAt: string | null;
  checks: ReferralPreflightCheck[];
  onRan: () => void;
}) {
  const run = useMutation({
    mutationFn: () => runPreflight(referralId),
    onSuccess: onRan,
  });
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {preflightCompletedAt
            ? `Last run ${new Date(preflightCompletedAt).toLocaleString()}`
            : "Never run"}
        </div>
        <Button
          intent="ghost"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <RefreshCw className="h-3 w-3 mr-1" />
          )}
          Run pre-flight now
        </Button>
      </div>
      {checks.length === 0 ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No checks recorded yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {checks.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between border rounded px-2 py-1 text-xs"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <span className="font-mono">{c.checkKind}</span>
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${PREFLIGHT_BADGE[c.outcomeStatus]}`}
              >
                {c.outcomeStatus}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Callbacks pane
// ────────────────────────────────────────────────────────────────────

function CallbacksPane({
  referralId,
  callbacks,
  onResent,
}: {
  referralId: string;
  callbacks: ReferralStatusCallback[];
  onResent: () => void;
}) {
  const [eventType, setEventType] = useState<ReferralLifecycleEvent>("order.accepted");
  const resend = useMutation({
    mutationFn: () => resendStatus(referralId, eventType),
    onSuccess: onResent,
  });
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <select
          className="rounded border px-2 py-1 text-xs"
          style={{ borderColor: "hsl(var(--line-1))" }}
          value={eventType}
          onChange={(e) => setEventType(e.target.value as ReferralLifecycleEvent)}
        >
          <option value="order.accepted">order.accepted</option>
          <option value="order.rejected">order.rejected</option>
          <option value="prior_auth.decision">prior_auth.decision</option>
          <option value="shop_order.shipped">shop_order.shipped</option>
          <option value="shop_order.delivered">shop_order.delivered</option>
        </select>
        <Button
          intent="ghost"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          {resend.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : null}
          Resend status
        </Button>
      </div>
      {callbacks.length === 0 ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No callbacks fired yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {callbacks.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between border rounded px-2 py-1 text-xs"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <span>
                <span className="font-mono">{c.eventType}</span>
                <span className="ml-2" style={{ color: "hsl(var(--ink-3))" }}>
                  · {c.targetKind} · attempt {c.attemptCount}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {c.status === "delivered" ? (
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                ) : c.status === "exhausted" ? (
                  <XCircle className="h-3 w-3 text-rose-600" />
                ) : null}
                <span className="text-[10px] uppercase font-semibold">{c.status}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Share tokens pane
// ────────────────────────────────────────────────────────────────────

function ShareTokensPane({
  referralId,
  tokens,
  onChanged,
}: {
  referralId: string;
  tokens: ReferralShareToken[];
  onChanged: () => void;
}) {
  const [lastMinted, setLastMinted] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const mint = useMutation({
    mutationFn: () => mintShareToken(referralId),
    onSuccess: (data) => {
      setLastMinted({ token: data.token, expiresAt: data.expiresAt });
      onChanged();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeShareToken(referralId, id),
    onSuccess: onChanged,
  });
  function copy(text: string) {
    void navigator.clipboard.writeText(text);
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Shareable read-only timeline links for the ordering clinician.
        </span>
        <Button
          intent="ghost"
          disabled={mint.isPending}
          onClick={() => mint.mutate()}
        >
          {mint.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Share2 className="h-3 w-3 mr-1" />
          )}
          Mint new link (30 day)
        </Button>
      </div>
      {lastMinted && (
        <div
          className="rounded border p-2 text-xs space-y-1"
          style={{ borderColor: "hsl(var(--penn-gold))", backgroundColor: "hsl(var(--bg-2))" }}
        >
          <div className="font-semibold flex items-center gap-1">
            <ShieldCheck className="h-3 w-3" />
            Copy this link now — we won&apos;t show it again
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-[10px]">
              {`${window.location.origin}/portal/clinician/${lastMinted.token}`}
            </code>
            <button
              type="button"
              className="text-[hsl(var(--penn-navy))] hover:underline"
              onClick={() =>
                copy(
                  `${window.location.origin}/portal/clinician/${lastMinted.token}`,
                )
              }
            >
              <ClipboardCopy className="h-3 w-3" />
            </button>
          </div>
          <div style={{ color: "hsl(var(--ink-3))" }}>
            expires {new Date(lastMinted.expiresAt).toLocaleString()}
          </div>
        </div>
      )}
      {tokens.length === 0 ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No share links minted yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {tokens.map((t) => {
            const expired = Date.parse(t.expiresAt) <= Date.now();
            const dead = t.revokedAt !== null || expired;
            return (
              <li
                key={t.id}
                className="flex items-center justify-between border rounded px-2 py-1 text-xs"
                style={{ borderColor: "hsl(var(--line-2))" }}
              >
                <span style={{ color: dead ? "hsl(var(--ink-3))" : undefined }}>
                  <span className="font-mono">{t.id.slice(0, 8)}…</span>
                  <span className="ml-2">
                    {t.viewCount} view{t.viewCount === 1 ? "" : "s"}
                  </span>
                  <span className="ml-2">
                    expires {new Date(t.expiresAt).toLocaleDateString()}
                  </span>
                  {t.revokedAt && <span className="ml-2 text-rose-700">revoked</span>}
                  {!t.revokedAt && expired && <span className="ml-2">expired</span>}
                </span>
                {!dead && (
                  <button
                    type="button"
                    className="text-rose-700 hover:underline"
                    onClick={() => revoke.mutate(t.id)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Accept pane
// ────────────────────────────────────────────────────────────────────

function AcceptPane({
  referralId,
  referral,
  onAccepted,
}: {
  referralId: string;
  referral: { triageStatus: ReferralTriageStatus; patientMatchId: string | null; providerMatchId: string | null };
  onAccepted: () => void;
}) {
  const [patientId, setPatientId] = useState(referral.patientMatchId ?? "");
  const [providerId, setProviderId] = useState(referral.providerMatchId ?? "");
  const [orderKind, setOrderKind] = useState("shop_order");
  const [orderId, setOrderId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const accept = useMutation({
    mutationFn: () =>
      acceptInboundReferral(referralId, {
        patientId: patientId.trim(),
        providerId: providerId.trim() || null,
        acceptedOrderKind: orderKind.trim(),
        acceptedOrderId: orderId.trim(),
      }),
    onSuccess: () => {
      setError(null);
      onAccepted();
    },
    onError: (e: Error) => setError(e.message),
  });
  const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s.trim());
  const valid =
    isUuid(patientId) &&
    isUuid(orderId) &&
    (providerId === "" || isUuid(providerId)) &&
    orderKind.trim().length > 0 &&
    referral.triageStatus !== "accepted";

  return (
    <div className="space-y-3 text-sm">
      {referral.triageStatus === "accepted" ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          This referral was already accepted.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Patient UUID" value={patientId} onChange={setPatientId} invalid={!isUuid(patientId)} />
            <Field
              label="Provider UUID (optional)"
              value={providerId}
              onChange={setProviderId}
              invalid={providerId !== "" && !isUuid(providerId)}
            />
            <Field
              label="Order kind"
              value={orderKind}
              onChange={setOrderKind}
              invalid={orderKind.trim().length === 0}
              placeholder="shop_order | episode | …"
            />
            <Field
              label="Order UUID"
              value={orderId}
              onChange={setOrderId}
              invalid={!isUuid(orderId)}
              placeholder="copy from the order you just created"
            />
          </div>
          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
              {error}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              disabled={accept.isPending || !valid}
              onClick={() => accept.mutate()}
            >
              {accept.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : null}
              Accept referral
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  invalid,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1" style={{ color: "hsl(var(--penn-navy))" }}>
        {label}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ borderColor: invalid ? "#dc2626" : undefined }}
      />
    </div>
  );
}
