import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import {
  usePatientPackets,
  usePatientPacketTemplates,
  useSendPatientPacket,
  useResendPatientPacket,
  useVoidPatientPacket,
  getPatientPacketsQueryKey,
  patientPacketPdfUrl,
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
import {
  fmtPatientPacketDate as fmtDate,
  patientPacketReceiptLabel,
  patientPacketReceiptVariant,
} from "@/components/admin/patient-packet-status";

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
  const onboardingTemplates = templates.filter((t) => !t.standalone);
  const standaloneTemplateCount = templates.length - onboardingTemplates.length;

  useEffect(() => {
    const list = templatesQuery.data?.templates?.filter((t) => !t.standalone);
    if (!seeded && list) {
      const init: Record<string, boolean> = {};
      for (const t of list) init[t.key] = t.defaultIncluded;
      setSelectedKeys(init);
      setSeeded(true);
    }
  }, [templatesQuery.data, seeded]);

  const chosen = onboardingTemplates.filter((t) => selectedKeys[t.key]);

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
          ? "Packet sent by email and text. Track receipt below; once signed, the signed PDF is available here and in the chart filing flow."
          : res.emailSent
            ? "Packet sent by email. Track receipt below; once signed, the signed PDF is available here and in the chart filing flow."
            : res.smsSent
              ? "Packet sent by text. Track receipt below; once signed, the signed PDF is available here and in the chart filing flow."
              : "Packet created. Share the link below and track receipt in the packet list.",
      );
      setShowSend(false);
      refresh();
    } catch (err) {
      setError(describeError(err).detail ?? "Failed to send packet.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Quick send onboarding packet
          </h3>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Send this patient's onboarding documents for electronic signature.
            Use the full sender for ABN, refill, custom, or alternate-contact
            packets.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Link
            href="/admin/patient-packets"
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-xs font-semibold transition-all"
            style={{
              backgroundColor: "hsl(var(--surface-2))",
              color: "hsl(var(--penn-navy-deep))",
              borderColor: "hsl(var(--penn-gold))",
            }}
          >
            Full sender
          </Link>
          <Button size="sm" onClick={() => setShowSend((s) => !s)}>
            {showSend ? "Cancel" : "Quick send"}
          </Button>
        </div>
      </div>

      {showSend && (
        <div
          className="rounded-md border p-4 space-y-4"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div>
            <Label htmlFor="pkt-docs">Onboarding documents</Label>
            {templatesQuery.isPending ? (
              <Spinner label="Loading documents…" />
            ) : onboardingTemplates.length === 0 ? (
              <EmptyState
                title="No onboarding templates"
                hint="Open the full Document packets page to review the template catalog."
              />
            ) : (
              <div className="space-y-1.5" id="pkt-docs">
                {onboardingTemplates.map((t) => (
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
            {standaloneTemplateCount > 0 && (
              <p
                className="mt-2 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Standalone forms such as ABN or refill confirmations are sent
                from the full Document packets page so they are not bundled with
                onboarding paperwork.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="pkt-ch">Send via</Label>
            <div className="flex gap-2" id="pkt-ch">
              <button
                type="button"
                aria-pressed={useEmailCh}
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
                aria-pressed={useSmsCh}
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

          <Button
            onClick={handleSend}
            isLoading={send.isPending}
            disabled={chosen.length === 0}
          >
            Send onboarding packet
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
                <th className="py-2 pr-4 font-medium">Receipt</th>
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
                      <Badge variant={patientPacketReceiptVariant(p)}>
                        {patientPacketReceiptLabel(p)}
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
                          Signed PDF
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
