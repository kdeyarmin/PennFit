// /admin/signature-tracking — "Awaiting Signatures" dashboard.
//
// Every document sent out for a provider signature (prescription
// requests + signable manual documents) is tracked here until the signed
// copy comes back. The page gives:
//   • an at-a-glance rollup of how many signatures each provider/practice
//     still owes, most-overdue first;
//   • a "scan or enter a returned barcode" box so a signed fax is filed
//     in one step (the same code printed as a barcode on the document);
//   • a worklist of every outstanding document with one-click print
//     (the barcoded PDF), resend-by-fax, mark-returned, and cancel.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import { Input, Label, Select } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  cancelSignatureTracking,
  listOutstandingSignatures,
  lookupSignatureByCode,
  markSignatureHandDelivered,
  markSignatureReturned,
  resendSignatureDocument,
  type SignatureDeliveryChannel,
  type SignatureDocumentKind,
  type SignatureListStatus,
  type SignatureTrackingItem,
  type SignatureTrackingStatus,
} from "@/lib/admin/signature-tracking-api";

type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const KIND_LABEL: Record<SignatureDocumentKind, string> = {
  prescription_request: "Prescription request",
  manual_document: "Manual document",
};

const CHANNEL_LABEL: Record<SignatureDeliveryChannel, string> = {
  none: "Not sent yet",
  fax: "Faxed",
  email: "Emailed",
  hand_delivery: "Hand-delivered",
};

const STATUS_LABEL: Record<SignatureTrackingStatus, string> = {
  awaiting_signature: "Awaiting signature",
  returned_signed: "Returned signed",
  canceled: "Canceled",
};

// Worklist filter labels — the stored statuses plus the "unsent" view
// (created but never faxed/emailed/hand-delivered).
const FILTER_LABEL: Record<SignatureListStatus, string> = {
  awaiting_signature: "Awaiting signature",
  unsent: "Not sent yet",
  returned_signed: "Returned signed",
  canceled: "Canceled",
};

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function ageVariant(days: number): BadgeVariant {
  if (days >= 14) return "danger";
  if (days >= 7) return "warning";
  return "neutral";
}

function ageLabel(iso: string): string {
  const d = daysSince(iso);
  if (d <= 0) return "today";
  if (d === 1) return "1 day";
  return `${d} days`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function AdminSignatureTrackingPage() {
  useDocumentTitle("Awaiting signatures");
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] =
    useState<SignatureListStatus>("awaiting_signature");

  const listKey = ["signature-tracking", "list", statusFilter] as const;
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => listOutstandingSignatures({ status: statusFilter }),
  });

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["signature-tracking"] });

  const items = listQuery.data?.items ?? [];
  const groups = listQuery.data?.byProvider ?? [];

  return (
    <div className="admin-root">
      <div className="space-y-6 max-w-6xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-xl font-bold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Awaiting signatures
            </h1>
            <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              Every document sent to a provider to sign is tracked here until
              the signed copy comes back. Scan the barcode on a returned fax to
              file it instantly.
            </p>
          </div>
          <Select
            id="statusFilter"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as SignatureListStatus)
            }
            options={[
              { value: "awaiting_signature", label: "Awaiting signature" },
              { value: "unsent", label: "Not sent yet" },
              { value: "returned_signed", label: "Returned signed" },
              { value: "canceled", label: "Canceled" },
            ]}
          />
        </div>

        {/* Returned-fax barcode lookup */}
        <ReturnedFaxLookup onFiled={() => void refresh()} />

        {/* At-a-glance: outstanding per provider */}
        {statusFilter === "awaiting_signature" && groups.length > 0 && (
          <Card
            title="By provider"
            subtitle="Most overdue first — total outstanding signatures per office"
          >
            <div className="p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map((g) => {
                const days = daysSince(g.oldestCreatedAt);
                return (
                  <div
                    key={`${g.providerId ?? "none"}-${g.label}`}
                    className="rounded-md border p-3"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <div
                      className="font-medium truncate"
                      style={{ color: "hsl(var(--ink-1))" }}
                      title={g.label}
                    >
                      {g.label}
                    </div>
                    {g.practiceName && g.practiceName !== g.label && (
                      <div
                        className="text-xs truncate"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {g.practiceName}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <span
                        className="text-2xl font-bold"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {g.count}
                      </span>
                      <span
                        className="text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        outstanding
                      </span>
                      <span className="ml-auto">
                        <Badge variant={ageVariant(days)}>
                          oldest {ageLabel(g.oldestCreatedAt)}
                        </Badge>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Worklist */}
        <Card
          title={
            statusFilter === "awaiting_signature"
              ? "Outstanding documents"
              : FILTER_LABEL[statusFilter]
          }
        >
          {listQuery.isPending ? (
            <div className="p-6">
              <Spinner label="Loading…" />
            </div>
          ) : listQuery.isError ? (
            <div className="p-4">
              <ErrorPanel error={listQuery.error} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title={
                statusFilter === "awaiting_signature"
                  ? "Nothing awaiting a signature"
                  : statusFilter === "unsent"
                    ? "No unsent documents"
                    : "No documents here"
              }
              hint={
                statusFilter === "awaiting_signature"
                  ? 'Documents show up here automatically once they\'re faxed, emailed, or marked hand-delivered. Drafts wait under "Not sent yet" until then.'
                  : statusFilter === "unsent"
                    ? "Newly created signable documents wait here until they're faxed, emailed, or marked hand-delivered."
                    : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    <th className="px-4 py-2 font-medium">Tracking #</th>
                    <th className="px-4 py-2 font-medium">Document</th>
                    <th className="px-4 py-2 font-medium">Patient</th>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="px-4 py-2 font-medium">Sent</th>
                    <th className="px-4 py-2 font-medium text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <SignatureRow
                      key={item.id}
                      item={item}
                      onChanged={() => void refresh()}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Returned-fax barcode lookup ────────────────────────────────────
function ReturnedFaxLookup({ onFiled }: { onFiled: () => void }) {
  const [code, setCode] = useState("");
  const [found, setFound] = useState<SignatureTrackingItem | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const lookup = useMutation({
    mutationFn: () => lookupSignatureByCode(code.trim()),
    onSuccess: (res) => {
      setFound(res.item);
      setMsg(null);
    },
    onError: (err) => {
      setFound(null);
      const notFound = err instanceof ApiError && err.status === 404;
      setMsg({
        kind: "err",
        text: notFound
          ? "No document matches that code. Check the barcode and try again."
          : (describeError(err).detail ?? "Lookup failed."),
      });
    },
  });

  const markReturned = useMutation({
    mutationFn: (id: string) => markSignatureReturned(id),
    onSuccess: () => {
      setMsg({
        kind: "ok",
        text: `Filed ${found?.trackingCode ?? "document"} as returned & signed.`,
      });
      setFound(null);
      setCode("");
      onFiled();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Could not mark it returned.",
      }),
  });

  return (
    <Card
      title="File a returned fax"
      subtitle="Scan the barcode (or type the tracking code) from the signed copy"
    >
      <div className="p-4 space-y-3">
        <form
          className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) lookup.mutate();
          }}
        >
          <div>
            <Label htmlFor="trackingCode">Tracking code</Label>
            <Input
              id="trackingCode"
              autoFocus
              placeholder="PFS-XXXXXXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <Button type="submit" isLoading={lookup.isPending}>
            Look up
          </Button>
        </form>

        {found && (
          <div
            className="rounded-md border p-3 flex flex-wrap items-center gap-3"
            style={{ borderColor: "hsl(var(--line-2))" }}
          >
            <div className="min-w-0">
              <div
                className="font-medium truncate"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {found.title}
                <span className="ml-2">
                  <Badge variant="info">{KIND_LABEL[found.documentKind]}</Badge>
                </span>
              </div>
              <div
                className="text-xs truncate"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {found.trackingCode}
                {found.patientLabel ? ` · ${found.patientLabel}` : ""}
                {found.providerLabel ? ` · ${found.providerLabel}` : ""}
                {" · "}
                {STATUS_LABEL[found.status]}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <a
                href={found.documentPdfPath}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button intent="ghost" size="sm">
                  View PDF
                </Button>
              </a>
              {found.status === "awaiting_signature" ? (
                <Button
                  size="sm"
                  isLoading={markReturned.isPending}
                  onClick={() => markReturned.mutate(found.id)}
                >
                  Mark returned & signed
                </Button>
              ) : (
                <Badge variant="success">
                  Already {STATUS_LABEL[found.status]}
                </Badge>
              )}
            </div>
          </div>
        )}

        {msg && (
          <div
            className="text-sm"
            style={{
              color: msg.kind === "ok" ? "hsl(142 60% 30%)" : "hsl(0 70% 45%)",
            }}
          >
            {msg.text}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── One worklist row ───────────────────────────────────────────────
function SignatureRow({
  item,
  onChanged,
}: {
  item: SignatureTrackingItem;
  onChanged: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const isOutstanding = item.status === "awaiting_signature";
  const age = daysSince(item.createdAt);

  const neverSent = item.sentCount === 0;

  const resend = useMutation({
    mutationFn: () => resendSignatureDocument(item),
    onSuccess: () => {
      setMsg(neverSent ? "Fax sent." : "Fax re-sent.");
      onChanged();
    },
    onError: (err) => setMsg(describeError(err).detail ?? "Send failed."),
  });

  const handDelivered = useMutation({
    mutationFn: () => markSignatureHandDelivered(item.id),
    onSuccess: () => {
      setMsg("Marked hand-delivered — now counted as outstanding.");
      onChanged();
    },
    onError: (err) => setMsg(describeError(err).detail ?? "Failed."),
  });

  const markReturned = useMutation({
    mutationFn: () => markSignatureReturned(item.id),
    onSuccess: onChanged,
    onError: (err) => setMsg(describeError(err).detail ?? "Failed."),
  });

  const cancel = useMutation({
    mutationFn: () => cancelSignatureTracking(item.id),
    onSuccess: onChanged,
    onError: (err) => setMsg(describeError(err).detail ?? "Failed."),
  });

  return (
    <tr
      className="border-t align-top"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <td className="px-4 py-3">
        <span
          className="font-mono text-xs font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {item.trackingCode}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
          {item.title}
        </div>
        <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {KIND_LABEL[item.documentKind]}
        </div>
      </td>
      <td className="px-4 py-3" style={{ color: "hsl(var(--ink-2))" }}>
        {item.patientLabel ?? "—"}
      </td>
      <td className="px-4 py-3" style={{ color: "hsl(var(--ink-2))" }}>
        {item.providerLabel ?? "—"}
        {item.practiceName && item.practiceName !== item.providerLabel && (
          <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {item.practiceName}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge variant={ageVariant(age)}>{ageLabel(item.createdAt)}</Badge>
        </div>
        <div className="text-xs mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          {CHANNEL_LABEL[item.deliveryChannel]}
          {item.sentCount > 1 ? ` ×${item.sentCount}` : ""}
          {item.lastSentAt ? ` · ${fmtDate(item.lastSentAt)}` : ""}
        </div>
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        <a
          href={item.documentPdfPath}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold mr-3"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          Print
        </a>
        {isOutstanding && (
          <>
            <Button
              intent="ghost"
              size="sm"
              isLoading={resend.isPending}
              onClick={() => {
                setMsg(null);
                resend.mutate();
              }}
            >
              {neverSent ? "Send fax" : "Resend fax"}
            </Button>
            {neverSent && (
              <Button
                intent="ghost"
                size="sm"
                isLoading={handDelivered.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Mark this document as hand-delivered? It will be counted as outstanding until the signed copy comes back.",
                    )
                  ) {
                    setMsg(null);
                    handDelivered.mutate();
                  }
                }}
              >
                Mark hand-delivered
              </Button>
            )}
            <Button
              intent="ghost"
              size="sm"
              isLoading={markReturned.isPending}
              onClick={() => {
                setMsg(null);
                markReturned.mutate();
              }}
            >
              Mark returned
            </Button>
            <Button
              intent="ghost"
              size="sm"
              isLoading={cancel.isPending}
              onClick={() => {
                if (window.confirm("Remove this from the signature queue?")) {
                  setMsg(null);
                  cancel.mutate();
                }
              }}
            >
              Cancel
            </Button>
          </>
        )}
        {msg && (
          <div className="text-xs mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            {msg}
          </div>
        )}
      </td>
    </tr>
  );
}

export default AdminSignatureTrackingPage;
