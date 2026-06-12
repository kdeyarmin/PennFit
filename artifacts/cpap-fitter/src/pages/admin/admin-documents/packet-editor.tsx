// /admin/documents — Packet editor: loads one document packet and
// renders the edit form (title, member order, cover sheet toggle,
// recipient block, save/download/email/fax/delete).

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import {
  deleteManualDocumentPacket,
  getManualDocumentPacket,
  manualDocumentPacketPdfUrl,
  sendManualDocumentPacketEmail,
  sendManualDocumentPacketFax,
  updateManualDocumentPacket,
  type ManualDocumentPacketDetail,
  type ManualDocumentSummary,
  type ManualDocumentType,
  type ManualDocumentTypeDef,
} from "@/lib/admin/manual-documents-api";
import { openPdfInNewTab, summarizePdfError } from "@/lib/admin/pdf-download";
import { sendErrorText } from "@/lib/admin/send-error";

import { PACKET_STATUS_LABEL, PACKET_STATUS_VARIANT } from "./shared";

export function PacketEditor({
  packetId,
  types,
  allDocuments,
  checkedIds,
  onClearChecked,
  onClose,
  onChanged,
}: {
  packetId: string;
  types: ManualDocumentTypeDef[];
  allDocuments: ManualDocumentSummary[];
  checkedIds: Set<string>;
  onClearChecked: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const detailKey = ["manual-document-packets", "detail", packetId] as const;
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => getManualDocumentPacket(packetId),
  });

  if (detailQuery.isPending) {
    return (
      <Card
        title="Packet"
        action={
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="p-6">
          <Spinner label="Loading…" />
        </div>
      </Card>
    );
  }
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Card
        title="Packet"
        action={
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="p-4">
          <ErrorPanel error={detailQuery.error} />
        </div>
      </Card>
    );
  }

  return (
    <PacketEditorForm
      key={packetId}
      detail={detailQuery.data}
      types={types}
      allDocuments={allDocuments}
      checkedIds={checkedIds}
      onClearChecked={onClearChecked}
      onClose={onClose}
      onSaved={() => {
        void qc.invalidateQueries({ queryKey: detailKey });
        onChanged();
      }}
    />
  );
}

function PacketEditorForm({
  detail,
  types,
  allDocuments,
  checkedIds,
  onClearChecked,
  onClose,
  onSaved,
}: {
  detail: ManualDocumentPacketDetail;
  types: ManualDocumentTypeDef[];
  allDocuments: ManualDocumentSummary[];
  checkedIds: Set<string>;
  onClearChecked: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const packet = detail.packet;
  const [title, setTitle] = useState(packet.title);
  const [includeCoverSheet, setIncludeCoverSheet] = useState(
    packet.include_cover_sheet,
  );
  const [recipientName, setRecipientName] = useState(
    packet.recipient_name ?? "",
  );
  const [recipientAddress, setRecipientAddress] = useState(
    packet.recipient_address ?? "",
  );
  const [recipientEmail, setRecipientEmail] = useState(
    packet.recipient_email ?? "",
  );
  const [recipientFax, setRecipientFax] = useState(
    packet.recipient_fax_e164 ?? "",
  );
  // Member order starts from the SURVIVING documents — saving heals a
  // packet whose members were deleted since it was assembled.
  const [docIds, setDocIds] = useState<string[]>(
    detail.documents.map((d) => d.id),
  );
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // Title/type lookup: packet detail first, then the page's document list
  // (for documents just added from the table).
  const memberInfo = useMemo(() => {
    const map = new Map<string, { title: string; type: ManualDocumentType }>();
    for (const d of allDocuments) {
      map.set(d.id, { title: d.title, type: d.document_type });
    }
    for (const d of detail.documents) {
      map.set(d.id, { title: d.title, type: d.document_type });
    }
    return map;
  }, [allDocuments, detail.documents]);

  const typeLabel = (t: ManualDocumentType) =>
    types.find((d) => d.type === t)?.label ?? t;

  // The send paths persist the form first so the rendered packet (cover
  // sheet recipient, document list/order) always matches what's typed —
  // otherwise an edited recipient could receive a PDF naming the
  // previous one.
  const persistPacket = () =>
    updateManualDocumentPacket(packet.id, {
      title: title.trim(),
      documentIds: docIds,
      includeCoverSheet,
      recipientName: recipientName.trim() || null,
      recipientAddress: recipientAddress.trim() || null,
      recipientEmail: recipientEmail.trim() || null,
      recipientFaxE164: recipientFax.trim() || null,
    });

  const save = useMutation({
    mutationFn: persistPacket,
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved." });
      onSaved();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Save failed.",
      }),
  });

  const del = useMutation({
    mutationFn: () => deleteManualDocumentPacket(packet.id),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Delete failed.",
      }),
  });

  const emailMut = useMutation({
    mutationFn: async () => {
      await persistPacket();
      return sendManualDocumentPacketEmail(packet.id, {
        email: recipientEmail.trim() || undefined,
      });
    },
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved and emailed to the recipient." });
      onSaved();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: sendErrorText(err, "Email failed.") }),
  });

  const faxMut = useMutation({
    mutationFn: async () => {
      await persistPacket();
      return sendManualDocumentPacketFax(packet.id, {
        fax: recipientFax.trim() || undefined,
      });
    },
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved and queued the fax." });
      onSaved();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: sendErrorText(err, "Fax failed.") }),
  });

  // Download persists the form first (same contract as the send paths,
  // so the combined PDF matches what's typed) and pre-flights the fetch
  // so a render failure shows here instead of raw JSON in a new tab.
  const download = useMutation({
    mutationFn: async () => {
      await persistPacket();
      return openPdfInNewTab(manualDocumentPacketPdfUrl(packet.id));
    },
    onSuccess: (result) => {
      if (!result.ok) {
        setMsg({
          kind: "err",
          text: `Download failed: ${summarizePdfError(result.error)}`,
        });
        return;
      }
      onSaved();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Download failed.",
      }),
  });

  // The packet endpoints require ≥1 member and a destination — catch
  // both here so the operator gets a plain message instead of a raw
  // validation error after a server round-trip.
  const guardPacket = (needs?: "email" | "fax"): boolean => {
    if (docIds.length === 0) {
      setMsg({
        kind: "err",
        text: "Add at least one document to the packet first.",
      });
      return false;
    }
    if (needs === "email" && !recipientEmail.trim()) {
      setMsg({
        kind: "err",
        text: "Enter a recipient email (in the Recipient section) first.",
      });
      return false;
    }
    if (needs === "fax" && !recipientFax.trim()) {
      setMsg({
        kind: "err",
        text: "Enter a recipient fax number (in the Recipient section) first.",
      });
      return false;
    }
    return true;
  };

  const move = (index: number, delta: -1 | 1) =>
    setDocIds((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const tmp = next[index]!;
      next[index] = next[target]!;
      next[target] = tmp;
      return next;
    });

  const remove = (id: string) =>
    setDocIds((prev) => prev.filter((d) => d !== id));

  // Same ordering rule as packet creation: table order first, then any
  // checked ids not currently listed (hidden by the status filter).
  const addable = [
    ...allDocuments.filter((d) => checkedIds.has(d.id)).map((d) => d.id),
    ...[...checkedIds].filter((id) => !allDocuments.some((d) => d.id === id)),
  ].filter((id) => !docIds.includes(id));

  return (
    <Card
      title={title.trim() || packet.title}
      subtitle={`Packet · ${docIds.length} document${docIds.length === 1 ? "" : "s"}`}
      action={
        <div className="flex items-center gap-2">
          <Badge variant={PACKET_STATUS_VARIANT[packet.status]}>
            {PACKET_STATUS_LABEL[packet.status]}
          </Badge>
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="p-5 space-y-5">
        {detail.missingDocumentIds.length > 0 && (
          <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
            {detail.missingDocumentIds.length} document
            {detail.missingDocumentIds.length === 1
              ? " in this packet has"
              : "s in this packet have"}{" "}
            been deleted. Saving removes them from the packet.
          </div>
        )}

        {/* Title */}
        <div>
          <Label htmlFor="packetTitle">Packet title</Label>
          <Input
            id="packetTitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Members, in send order */}
        <div className="space-y-2">
          <h3
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            Documents in this packet (send order)
          </h3>
          {docIds.length === 0 ? (
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              Empty — select documents in the table below and click “Add
              selected”.
            </p>
          ) : (
            <ol
              className="rounded-md border divide-y"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {docIds.map((id, i) => {
                const info = memberInfo.get(id);
                return (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span
                        className="text-sm font-medium"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {i + 1}. {info?.title ?? `Document ${id.slice(0, 8)}…`}
                      </span>
                      {info && (
                        <span
                          className="ml-2 text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {typeLabel(info.type)}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        intent="ghost"
                        size="sm"
                        aria-label="Move up"
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        intent="ghost"
                        size="sm"
                        aria-label="Move down"
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        intent="ghost"
                        size="sm"
                        onClick={() => remove(id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {addable.length > 0 && (
            <Button
              intent="secondary"
              size="sm"
              onClick={() => {
                setDocIds((prev) => [...prev, ...addable]);
                onClearChecked();
              }}
            >
              Add selected ({addable.length})
            </Button>
          )}
        </div>

        {/* Cover sheet */}
        <label
          className="flex items-center gap-2 text-sm"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          <input
            type="checkbox"
            checked={includeCoverSheet}
            onChange={(e) => setIncludeCoverSheet(e.target.checked)}
          />
          Start with a generated cover sheet (title, recipient, contents list)
        </label>

        {/* Recipient block */}
        <div
          className="rounded-md border p-3 space-y-3"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <h3
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            Recipient (optional)
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pktRecName">Name</Label>
              <Input
                id="pktRecName"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pktRecEmail">Email</Label>
              <Input
                id="pktRecEmail"
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pktRecFax">Fax (+1…)</Label>
              <Input
                id="pktRecFax"
                placeholder="+12155551234"
                value={recipientFax}
                onChange={(e) => setRecipientFax(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pktRecAddr">Address</Label>
              <Input
                id="pktRecAddr"
                value={recipientAddress}
                onChange={(e) => setRecipientAddress(e.target.value)}
              />
            </div>
          </div>
        </div>

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

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              if (!guardPacket()) return;
              setMsg(null);
              save.mutate();
            }}
            isLoading={save.isPending}
          >
            Save
          </Button>
          <Button
            intent="secondary"
            isLoading={download.isPending}
            onClick={() => {
              if (!guardPacket()) return;
              setMsg(null);
              download.mutate();
            }}
          >
            Download PDF
          </Button>
          <Button
            intent="secondary"
            isLoading={emailMut.isPending}
            onClick={() => {
              if (!guardPacket("email")) return;
              setMsg(null);
              emailMut.mutate();
            }}
          >
            Email packet
          </Button>
          <Button
            intent="secondary"
            isLoading={faxMut.isPending}
            onClick={() => {
              if (!guardPacket("fax")) return;
              setMsg(null);
              faxMut.mutate();
            }}
          >
            Fax packet
          </Button>
          <Button
            intent="ghost"
            isLoading={del.isPending}
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: "Delete this packet?",
                  description: "The documents inside it are not deleted.",
                  confirmLabel: "Delete packet",
                  destructive: true,
                });
                if (!ok) return;
                setMsg(null);
                del.mutate();
              })();
            }}
          >
            Delete packet
          </Button>
        </div>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          “Email packet” and “Fax packet” save your edits first, then send to
          the email / fax number typed above.
        </p>
        {ConfirmDialogEl}
      </div>
    </Card>
  );
}
