// /admin/documents — staff-authored, manually-typed PDF documents.
//
// CSRs type out one-off documents (CMN, prescription/order, agreement,
// delivery ticket, fax cover letter, or a free-form letter) by hand —
// deliberately without pre-populating any patient record — then
// download, email, fax, or file each one to a patient chart.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Input, Label, Select } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  attachManualDocument,
  createManualDocument,
  deleteManualDocument,
  getManualDocument,
  getManualDocumentCatalog,
  listManualDocuments,
  manualDocumentPdfUrl,
  searchPatientsForAttach,
  sendManualDocumentEmail,
  sendManualDocumentFax,
  updateManualDocument,
  type ManualDocumentStatus,
  type ManualDocumentSummary,
  type ManualDocumentType,
  type ManualDocumentTypeDef,
} from "@/lib/admin/manual-documents-api";

type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const STATUS_VARIANT: Record<ManualDocumentStatus, BadgeVariant> = {
  draft: "muted",
  sent: "info",
  attached: "success",
};

const STATUS_LABEL: Record<ManualDocumentStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  attached: "Filed to chart",
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

function Textarea({
  id,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full rounded-md border px-3 py-1.5 text-sm bg-white"
      style={{ borderColor: "hsl(var(--line-2))", color: "hsl(var(--ink-1))" }}
    />
  );
}

export function AdminDocumentsPage() {
  useDocumentTitle("Documents");
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [composing, setComposing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const catalogQuery = useQuery({
    queryKey: ["manual-documents", "catalog"],
    queryFn: getManualDocumentCatalog,
  });
  const types = useMemo(
    () => catalogQuery.data?.types ?? [],
    [catalogQuery.data],
  );

  const listKey = ["manual-documents", "list", statusFilter] as const;
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () =>
      listManualDocuments(
        statusFilter
          ? { status: statusFilter as ManualDocumentStatus }
          : undefined,
      ),
  });
  const documents = listQuery.data?.documents ?? [];

  const refreshList = () =>
    qc.invalidateQueries({ queryKey: ["manual-documents", "list"] });

  const typeLabel = (t: ManualDocumentType) =>
    types.find((d) => d.type === t)?.label ?? t;

  return (
    <div className="admin-root">
      <div className="space-y-6 max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-xl font-bold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Documents
            </h1>
            <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              Type out a CMN, prescription, agreement, delivery ticket, or fax
              cover by hand, then download, email, fax, or file it to a chart.
            </p>
          </div>
          <Button onClick={() => setComposing((s) => !s)}>
            {composing ? "Close" : "New document"}
          </Button>
        </div>

        {composing && (
          <NewDocumentPanel
            types={types}
            loadingTypes={catalogQuery.isPending}
            typesError={catalogQuery.isError ? catalogQuery.error : null}
            retryingTypes={catalogQuery.isFetching}
            onRetryTypes={() => void catalogQuery.refetch()}
            onCreated={(id) => {
              setComposing(false);
              setSelectedId(id);
              void refreshList();
            }}
            onClose={() => setComposing(false)}
          />
        )}

        {selectedId && (
          <DocumentEditor
            documentId={selectedId}
            types={types}
            onClose={() => setSelectedId(null)}
            onChanged={() => void refreshList()}
          />
        )}

        <Card
          title="All documents"
          action={
            <Select
              id="statusFilter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              emptyOptionLabel="All statuses"
              options={[
                { value: "draft", label: "Draft" },
                { value: "sent", label: "Sent" },
                { value: "attached", label: "Filed to chart" },
              ]}
            />
          }
        >
          {listQuery.isPending ? (
            <div className="p-6">
              <Spinner label="Loading documents…" />
            </div>
          ) : listQuery.isError ? (
            <div className="p-4">
              <ErrorPanel error={listQuery.error} />
            </div>
          ) : documents.length === 0 ? (
            <EmptyState
              title="No documents yet"
              hint="Click “New document” to type one out."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    <th className="px-5 py-2 font-medium">Title</th>
                    <th className="px-5 py-2 font-medium">Type</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                    <th className="px-5 py-2 font-medium">Created</th>
                    <th className="px-5 py-2 font-medium text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((d: ManualDocumentSummary) => (
                    <tr
                      key={d.id}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td className="px-5 py-3">
                        <div
                          className="font-medium"
                          style={{ color: "hsl(var(--ink-1))" }}
                        >
                          {d.title}
                        </div>
                        {d.recipient_name && (
                          <div
                            className="text-xs"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            To: {d.recipient_name}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {typeLabel(d.document_type)}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={STATUS_VARIANT[d.status]}>
                          {STATUS_LABEL[d.status]}
                        </Badge>
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {fmtDate(d.created_at)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <a
                          href={manualDocumentPdfUrl(d.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-semibold mr-3"
                          style={{ color: "hsl(var(--penn-navy))" }}
                        >
                          PDF
                        </a>
                        <Button
                          intent="ghost"
                          size="sm"
                          onClick={() => setSelectedId(d.id)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
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

// ── New document panel ────────────────────────────────────────────
function NewDocumentPanel({
  types,
  loadingTypes,
  typesError,
  retryingTypes,
  onRetryTypes,
  onCreated,
  onClose,
}: {
  types: ManualDocumentTypeDef[];
  loadingTypes: boolean;
  typesError: unknown;
  retryingTypes: boolean;
  onRetryTypes: () => void;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<string>("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({ mutationFn: createManualDocument });

  const def = types.find((t) => t.type === type) ?? null;

  const handleCreate = async () => {
    setError(null);
    if (!type) {
      setError("Choose a document type.");
      return;
    }
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    try {
      const res = await create.mutateAsync({
        documentType: type as ManualDocumentType,
        title: title.trim(),
      });
      onCreated(res.id);
    } catch (err) {
      setError(describeError(err).detail ?? "Failed to create document.");
    }
  };

  return (
    <Card
      title="New document"
      subtitle="Pick a type and give it a title — you’ll fill in the details next."
    >
      <div className="p-5 space-y-4">
        <div>
          <Label htmlFor="docType">Document type</Label>
          {loadingTypes ? (
            <Spinner label="Loading types…" />
          ) : typesError != null ? (
            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
                Couldn’t load the document types.{" "}
                {describeError(typesError).detail}
              </span>
              <Button
                intent="secondary"
                size="sm"
                isLoading={retryingTypes}
                onClick={onRetryTypes}
              >
                Try again
              </Button>
            </div>
          ) : (
            <Select
              id="docType"
              value={type}
              onChange={(e) => setType(e.target.value)}
              emptyOptionLabel="Choose a type…"
              options={types.map((t) => ({ value: t.type, label: t.label }))}
            />
          )}
          {def && (
            <p className="text-xs mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              {def.description}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="docTitle">Title</Label>
          <Input
            id="docTitle"
            placeholder="e.g. Certificate of Medical Necessity"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {error && (
          <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={handleCreate} isLoading={create.isPending}>
            Create &amp; edit
          </Button>
          <Button intent="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Document editor ───────────────────────────────────────────────
function DocumentEditor({
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

  const save = useMutation({
    mutationFn: () =>
      updateManualDocument(doc.id, {
        title: title.trim(),
        fields,
        body: body.trim() ? body : null,
        recipientName: recipientName.trim() || null,
        recipientAddress: recipientAddress.trim() || null,
        recipientEmail: recipientEmail.trim() || null,
        recipientFaxE164: recipientFax.trim() || null,
      }),
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

  const setField = (key: string, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

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
          <a
            href={manualDocumentPdfUrl(doc.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button intent="secondary">Download PDF</Button>
          </a>
          <Button
            intent="ghost"
            isLoading={del.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Delete this document? This can’t be undone. A copy already filed to a chart stays in the patient’s Documents tab.",
                )
              ) {
                setMsg(null);
                del.mutate();
              }
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
          onChanged={onSaved}
        />
      </div>
    </Card>
  );
}

// ── Send / attach actions ─────────────────────────────────────────
function SendActions({
  documentId,
  defaultEmail,
  defaultFax,
  onChanged,
}: {
  documentId: string;
  defaultEmail: string;
  defaultFax: string;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [fax, setFax] = useState(defaultFax);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const emailMut = useMutation({
    mutationFn: () =>
      sendManualDocumentEmail(documentId, { email: email.trim() || undefined }),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Emailed to the recipient." });
      onChanged();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Email failed.",
      }),
  });

  const faxMut = useMutation({
    mutationFn: () =>
      sendManualDocumentFax(documentId, { fax: fax.trim() || undefined }),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Fax queued." });
      onChanged();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: describeError(err).detail ?? "Fax failed." }),
  });

  const attachMut = useMutation({
    mutationFn: (patientId: string) =>
      attachManualDocument(documentId, { patientId }),
    onSuccess: () => {
      setMsg({
        kind: "ok",
        text: "Filed to the patient’s chart — it now appears in their Documents tab.",
      });
      setPicked(null);
      setSearch("");
      onChanged();
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Attach failed.",
      }),
  });

  const patientsQuery = useQuery({
    queryKey: ["manual-documents", "patient-search", search.trim()],
    queryFn: () => searchPatientsForAttach(search.trim()),
    enabled: search.trim().length >= 2 && !picked,
  });

  return (
    <div
      className="rounded-md border p-4 space-y-4"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <h3
        className="text-sm font-semibold"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        Send &amp; file
      </h3>

      {/* Email */}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="sendEmail">Email to</Label>
          <Input
            id="sendEmail"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          isLoading={emailMut.isPending}
          onClick={() => {
            setMsg(null);
            emailMut.mutate();
          }}
        >
          Email document
        </Button>
      </div>

      {/* Fax */}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="sendFax">Fax to (+1…)</Label>
          <Input
            id="sendFax"
            placeholder="+12155551234"
            value={fax}
            onChange={(e) => setFax(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          isLoading={faxMut.isPending}
          onClick={() => {
            setMsg(null);
            faxMut.mutate();
          }}
        >
          Send fax
        </Button>
      </div>

      {/* Attach to chart */}
      <div>
        <Label htmlFor="attachSearch">File to a patient chart</Label>
        {picked ? (
          <div
            className="flex items-center justify-between rounded-md border px-3 py-2"
            style={{ borderColor: "hsl(var(--line-2))" }}
          >
            <span style={{ color: "hsl(var(--ink-1))" }}>{picked.name}</span>
            <div className="flex gap-2">
              <Button
                size="sm"
                isLoading={attachMut.isPending}
                onClick={() => {
                  setMsg(null);
                  attachMut.mutate(picked.id);
                }}
              >
                File to chart
              </Button>
              <Button intent="ghost" size="sm" onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Input
              id="attachSearch"
              placeholder="Search by name or Pacware ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search.trim().length >= 2 && (
              <div
                className="mt-1 rounded-md border divide-y max-h-56 overflow-y-auto"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                {patientsQuery.isPending ? (
                  <div
                    className="px-3 py-2 text-sm"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    Searching…
                  </div>
                ) : (patientsQuery.data ?? []).length === 0 ? (
                  <div
                    className="px-3 py-2 text-sm"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    No matches.
                  </div>
                ) : (
                  (patientsQuery.data ?? []).map((pt) => (
                    <button
                      key={pt.id}
                      type="button"
                      className="block w-full text-left px-3 py-2 text-sm hover:bg-black/5"
                      style={{ color: "hsl(var(--ink-1))" }}
                      onClick={() =>
                        setPicked({
                          id: pt.id,
                          name: `${pt.firstName} ${pt.lastName}`.trim(),
                        })
                      }
                    >
                      {pt.firstName} {pt.lastName}
                      {pt.pacwareId && (
                        <span
                          className="ml-2 text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {pt.pacwareId}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        )}
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
    </div>
  );
}

export default AdminDocumentsPage;
