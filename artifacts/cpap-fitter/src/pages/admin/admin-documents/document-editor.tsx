// /admin/documents — Document editor: loads one manual document and
// renders the edit form (title, prefill-from-chart, recipient block,
// type-specific fields, body, save/download/delete, send actions).

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import {
  deleteManualDocument,
  getManualDocument,
  manualDocumentPdfUrl,
  updateManualDocument,
  type ManualDocumentPrefill,
  type ManualDocumentTypeDef,
} from "@/lib/admin/manual-documents-api";
import { openPdfInNewTab, summarizePdfError } from "@/lib/admin/pdf-download";

import { STATUS_LABEL, STATUS_VARIANT, Textarea } from "./shared";
import { PrefillFromChart } from "./prefill-from-chart";
import { SendActions } from "./send-actions";

export function DocumentEditor({
  documentId,
  types,
  onClose,
  onChanged,
}: {
  documentId: string;
  types: ManualDocumentTypeDef[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const detailKey = ["manual-documents", "detail", documentId] as const;
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => getManualDocument(documentId),
  });

  if (detailQuery.isPending) {
    return (
      <Card
        title="Document"
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
        title="Document"
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

  const doc = detailQuery.data.document;
  const def = types.find((t) => t.type === doc.document_type) ?? null;

  return (
    <DocumentEditorForm
      key={documentId}
      document={doc}
      def={def}
      onClose={onClose}
      onSaved={() => {
        void qc.invalidateQueries({ queryKey: detailKey });
        onChanged();
      }}
    />
  );
}

function DocumentEditorForm({
  document: doc,
  def,
  onClose,
  onSaved,
}: {
  document: import("@/lib/admin/manual-documents-api").ManualDocumentDetail;
  def: ManualDocumentTypeDef | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [fields, setFields] = useState<Record<string, string>>(
    doc.fields ?? {},
  );
  const [body, setBody] = useState(doc.body ?? "");
  const [recipientName, setRecipientName] = useState(doc.recipient_name ?? "");
  const [recipientAddress, setRecipientAddress] = useState(
    doc.recipient_address ?? "",
  );
  const [recipientEmail, setRecipientEmail] = useState(
    doc.recipient_email ?? "",
  );
  const [recipientFax, setRecipientFax] = useState(
    doc.recipient_fax_e164 ?? "",
  );
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const del = useMutation({
    mutationFn: () => deleteManualDocument(doc.id),
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

  // The send paths persist the form first so the rendered PDF always
  // matches what's typed — same contract as the packet editor.
  const persistDocument = () =>
    updateManualDocument(doc.id, {
      title: title.trim(),
      fields,
      body: body.trim() ? body : null,
      recipientName: recipientName.trim() || null,
      recipientAddress: recipientAddress.trim() || null,
      recipientEmail: recipientEmail.trim() || null,
      recipientFaxE164: recipientFax.trim() || null,
    });

  const save = useMutation({
    mutationFn: persistDocument,
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

  // Download persists the form first (same contract as the send paths,
  // so the PDF matches what's typed) and pre-flights the fetch so a
  // render failure shows here instead of raw JSON in a new tab.
  const download = useMutation({
    mutationFn: async () => {
      await persistDocument();
      return openPdfInNewTab(manualDocumentPdfUrl(doc.id));
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

  const setField = (key: string, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  // Merge chart suggestions into BLANK inputs only — anything the
  // operator already typed is never overwritten.
  const applyPrefill = (prefill: ManualDocumentPrefill) => {
    setFields((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(prefill.fields)) {
        if (!next[key]?.trim()) next[key] = value;
      }
      return next;
    });
    if (!recipientName.trim() && prefill.recipient.name)
      setRecipientName(prefill.recipient.name);
    if (!recipientAddress.trim() && prefill.recipient.address)
      setRecipientAddress(prefill.recipient.address);
    if (!recipientEmail.trim() && prefill.recipient.email)
      setRecipientEmail(prefill.recipient.email);
    if (!recipientFax.trim() && prefill.recipient.fax)
      setRecipientFax(prefill.recipient.fax);
  };

  return (
    <Card
      title={doc.title}
      subtitle={def?.label ?? doc.document_type}
      action={
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[doc.status]}>
            {STATUS_LABEL[doc.status]}
          </Badge>
          <Button intent="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="p-5 space-y-5">
        {/* Title */}
        <div>
          <Label htmlFor="editTitle">Title</Label>
          <Input
            id="editTitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Prefill from chart (suggestions only; blanks-only merge) */}
        <PrefillFromChart
          documentType={doc.document_type}
          onApply={applyPrefill}
        />

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
              <Label htmlFor="recName">Name</Label>
              <Input
                id="recName"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="recEmail">Email</Label>
              <Input
                id="recEmail"
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="recFax">Fax (+1…)</Label>
              <Input
                id="recFax"
                placeholder="+12155551234"
                value={recipientFax}
                onChange={(e) => setRecipientFax(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="recAddr">Address</Label>
              <Input
                id="recAddr"
                value={recipientAddress}
                onChange={(e) => setRecipientAddress(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Type-specific fields */}
        {def && def.fields.length > 0 && (
          <div className="space-y-3">
            <h3
              className="text-sm font-semibold"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              Details
            </h3>
            {def.fields.map((f) => (
              <div key={f.key}>
                <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                {f.kind === "textarea" ? (
                  <Textarea
                    id={`f-${f.key}`}
                    value={fields[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(v) => setField(f.key, v)}
                  />
                ) : (
                  <Input
                    id={`f-${f.key}`}
                    type={f.kind === "date" ? "date" : "text"}
                    placeholder={f.placeholder}
                    value={fields[f.key] ?? ""}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Free-form body */}
        <div>
          <Label htmlFor="editBody">Body / notes</Label>
          <Textarea
            id="editBody"
            rows={5}
            value={body}
            onChange={setBody}
            placeholder="Anything else to include in the document…"
          />
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
          <Button onClick={() => save.mutate()} isLoading={save.isPending}>
            Save
          </Button>
          <Button
            intent="secondary"
            isLoading={download.isPending}
            onClick={() => {
              setMsg(null);
              download.mutate();
            }}
          >
            Download PDF
          </Button>
          <Button
            intent="ghost"
            isLoading={del.isPending}
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: "Delete this document?",
                  description:
                    "This can’t be undone. A copy already filed to a chart stays in the patient’s Documents tab.",
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (!ok) return;
                setMsg(null);
                del.mutate();
              })();
            }}
          >
            Delete
          </Button>
        </div>

        {/* Delivery + chart actions */}
        <SendActions
          documentId={doc.id}
          defaultEmail={recipientEmail}
          defaultFax={recipientFax}
          persist={persistDocument}
          onChanged={onSaved}
        />
        {ConfirmDialogEl}
      </div>
    </Card>
  );
}
