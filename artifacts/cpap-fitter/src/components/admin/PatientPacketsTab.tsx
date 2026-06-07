import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  usePatientPackets,
  usePatientPacketTemplates,
  useSendPatientPacket,
  useResendPatientPacket,
  useVoidPatientPacket,
  getPatientPacketsQueryKey,
  patientPacketPdfUrl,
  type PatientPacketStatus,
  type PacketDeliveryDetails,
} from "@workspace/api-client-react/admin";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import { DeliveryItemsEditor } from "@/components/admin/DeliveryItemsEditor";
import { PacketEditForm } from "@/components/admin/PacketEditForm";

type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const STATUS_VARIANT: Record<PatientPacketStatus, BadgeVariant> = {
  draft: "muted",
  sent: "info",
  viewed: "info",
  completed: "success",
  voided: "danger",
  expired: "warning",
};
const STATUS_LABEL: Record<PatientPacketStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Opened",
  completed: "Signed",
  voided: "Voided",
  expired: "Expired",
};

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

export function PatientPacketsTab({
  patientId,
  hasEmail,
  hasPhone,
  onChanged,
}: {
  patientId: string;
  hasEmail: boolean;
  hasPhone: boolean;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const packetsQuery = usePatientPackets(patientId);
  const templatesQuery = usePatientPacketTemplates();
  const send = useSendPatientPacket();
  const resend = useResendPatientPacket();
  const voidPacket = useVoidPatientPacket();

  const [showSend, setShowSend] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [seeded, setSeeded] = useState(false);
  const [useEmailCh, setUseEmailCh] = useState(hasEmail);
  const [useSmsCh, setUseSmsCh] = useState(hasPhone);
  const [deliveryDetails, setDeliveryDetails] =
    useState<PacketDeliveryDetails | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [linkResult, setLinkResult] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const templates = templatesQuery.data?.templates ?? [];
  const packets = packetsQuery.data?.packets ?? [];

  useEffect(() => {
    const list = templatesQuery.data?.templates;
    if (!seeded && list && list.length > 0) {
      const init: Record<string, boolean> = {};
      for (const t of list) init[t.key] = t.defaultIncluded;
      setSelectedKeys(init);
      setSeeded(true);
    }
  }, [templatesQuery.data, seeded]);

  const chosen = templates.filter((t) => selectedKeys[t.key]);

  const refresh = () => {
    void qc.invalidateQueries({
      queryKey: getPatientPacketsQueryKey(patientId),
    });
    onChanged?.();
  };

  const handleSend = async () => {
    setError(null);
    setFeedback(null);
    setLinkResult(null);
    if (chosen.length === 0) {
      setError("Select at least one document.");
      return;
    }
    const channels: ("email" | "sms")[] = [];
    if (useEmailCh) channels.push("email");
    if (useSmsCh) channels.push("sms");
    if (channels.length === 0) {
      setError("Choose at least one delivery channel.");
      return;
    }
    try {
      const res = await send.mutateAsync({
        patientId,
        data: {
          documentKeys: chosen.map((t) => t.key),
          channels,
          deliveryDetails,
        },
      });
      setLinkResult(res.signingLink);
      setFeedback(
        res.emailSent && res.smsSent
          ? "Packet sent — emailed and texted to the patient."
          : res.emailSent
            ? "Packet sent — emailed to the patient."
            : res.smsSent
              ? "Packet sent — texted to the patient."
              : "Packet created — share the link below.",
      );
      setShowSend(false);
      refresh();
    } catch (err) {
      setError(describeError(err).detail ?? "Failed to send packet.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Document packets
          </h3>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Send onboarding documents for electronic signature.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowSend((s) => !s)}>
          {showSend ? "Cancel" : "Send packet"}
        </Button>
      </div>

      {showSend && (
        <div
          className="rounded-md border p-4 space-y-4"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div>
            <Label htmlFor="pkt-docs">Documents</Label>
            {templatesQuery.isPending ? (
              <Spinner label="Loading documents…" />
            ) : (
              <div className="space-y-1.5" id="pkt-docs">
                {templates.map((t) => (
                  <label
                    key={t.key}
                    className="flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={t.required || Boolean(selectedKeys[t.key])}
                      disabled={t.required}
                      onChange={() =>
                        setSelectedKeys({
                          ...selectedKeys,
                          [t.key]: !selectedKeys[t.key],
                        })
                      }
                    />
                    <span
                      className="text-sm"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {t.title}
                      {t.required ? (
                        <span
                          className="ml-2 text-xs font-medium"
                          style={{ color: "hsl(var(--penn-navy))" }}
                        >
                          (required)
                        </span>
                      ) : !t.requiresSignature ? (
                        <span
                          className="ml-2 text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          (informational)
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="pkt-ch">Send via</Label>
            <div className="flex gap-2" id="pkt-ch">
              <button
                type="button"
                onClick={() => setUseEmailCh((v) => !v)}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                style={{
                  borderColor: useEmailCh
                    ? "hsl(var(--penn-navy))"
                    : "hsl(var(--line-2))",
                  backgroundColor: useEmailCh
                    ? "hsl(var(--penn-navy) / 0.08)"
                    : "white",
                  color: useEmailCh
                    ? "hsl(var(--penn-navy-deep))"
                    : "hsl(var(--ink-3))",
                }}
              >
                {useEmailCh ? "✓ " : ""}Email
              </button>
              <button
                type="button"
                onClick={() => setUseSmsCh((v) => !v)}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                style={{
                  borderColor: useSmsCh
                    ? "hsl(var(--penn-navy))"
                    : "hsl(var(--line-2))",
                  backgroundColor: useSmsCh
                    ? "hsl(var(--penn-navy) / 0.08)"
                    : "white",
                  color: useSmsCh
                    ? "hsl(var(--penn-navy-deep))"
                    : "hsl(var(--ink-3))",
                }}
              >
                {useSmsCh ? "✓ " : ""}Text message
              </button>
            </div>
            {!hasEmail && useEmailCh && (
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                No email on file — add one to the patient record to deliver by
                email.
              </p>
            )}
            {!hasPhone && useSmsCh && (
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                No phone on file — add one to the patient record to deliver by
                text.
              </p>
            )}
          </div>

          <div
            className="rounded-md border p-3"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <DeliveryItemsEditor
              idPrefix="tab-send"
              onChange={setDeliveryDetails}
            />
          </div>

          {error && (
            <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
              {error}
            </div>
          )}

          <Button onClick={handleSend} isLoading={send.isPending}>
            Send packet
          </Button>
        </div>
      )}

      {feedback && (
        <div
          className="rounded-md p-3 text-sm"
          style={{
            backgroundColor: "hsl(142 70% 45% / 0.10)",
            color: "hsl(142 60% 25%)",
          }}
        >
          {feedback}
        </div>
      )}

      {linkResult && (
        <div>
          <Label htmlFor="pkt-link">Secure signing link</Label>
          <div className="flex gap-2">
            <Input id="pkt-link" readOnly value={linkResult} />
            <Button
              intent="secondary"
              onClick={() => void navigator.clipboard?.writeText(linkResult)}
            >
              Copy
            </Button>
          </div>
        </div>
      )}

      {editingId && (
        <PacketEditForm
          packetId={editingId}
          onSaved={() => {
            setEditingId(null);
            setFeedback("Packet updated.");
            refresh();
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      {packetsQuery.isPending ? (
        <Spinner label="Loading packets…" />
      ) : packetsQuery.isError ? (
        <ErrorPanel error={packetsQuery.error} />
      ) : packets.length === 0 ? (
        <EmptyState
          title="No packets yet"
          hint="Send a document packet for this patient to sign."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "hsl(var(--ink-3))" }}>
                <th className="py-2 pr-4 font-medium">Packet</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Sent</th>
                <th className="py-2 pr-4 font-medium">Signed</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {packets.map((p) => {
                const open = p.status === "sent" || p.status === "viewed";
                return (
                  <tr
                    key={p.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td
                      className="py-2 pr-4"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {p.title}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant={STATUS_VARIANT[p.status]}>
                        {STATUS_LABEL[p.status]}
                      </Badge>
                    </td>
                    <td
                      className="py-2 pr-4"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {fmtDate(p.sent_at)}
                    </td>
                    <td
                      className="py-2 pr-4"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {fmtDate(p.completed_at)}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {p.status === "completed" && (
                        <a
                          href={patientPacketPdfUrl(p.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-semibold mr-3"
                          style={{ color: "hsl(var(--penn-navy))" }}
                        >
                          PDF
                        </a>
                      )}
                      {open && (
                        <Button
                          intent="ghost"
                          size="sm"
                          onClick={() =>
                            setEditingId((cur) => (cur === p.id ? null : p.id))
                          }
                        >
                          {editingId === p.id ? "Close" : "Edit"}
                        </Button>
                      )}
                      {open && (
                        <Button
                          intent="ghost"
                          size="sm"
                          isLoading={resend.isPending}
                          onClick={async () => {
                            setError(null);
                            setFeedback(null);
                            try {
                              const res = await resend.mutateAsync({
                                packetId: p.id,
                              });
                              setLinkResult(res.signingLink);
                              setFeedback(
                                res.emailSent || res.smsSent
                                  ? "A fresh signing link was sent to the patient."
                                  : "A fresh link was issued — copy it below.",
                              );
                              refresh();
                            } catch (err) {
                              setError(
                                describeError(err).detail ?? "Resend failed.",
                              );
                            }
                          }}
                        >
                          Resend
                        </Button>
                      )}
                      {open && (
                        <Button
                          intent="ghost"
                          size="sm"
                          isLoading={voidPacket.isPending}
                          onClick={async () => {
                            setError(null);
                            try {
                              await voidPacket.mutateAsync({ packetId: p.id });
                              setFeedback("Packet voided.");
                              refresh();
                            } catch (err) {
                              setError(
                                describeError(err).detail ?? "Void failed.",
                              );
                            }
                          }}
                        >
                          Void
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PatientPacketsTab;
