// /admin/documents — staff-authored, manually-typed PDF documents.
//
// CSRs type out one-off documents (CMN, prescription/order, agreement,
// delivery ticket, fax cover letter, or a free-form letter) by hand,
// optionally prefilling blank inputs from a patient's chart (the
// "Prefill from chart" picker — nothing is ever filled silently), then
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
  createManualDocumentPacket,
  deleteManualDocument,
  deleteManualDocumentPacket,
  getManualDocument,
  getManualDocumentCatalog,
  getManualDocumentPacket,
  getManualDocumentPrefill,
  getStandardDocumentCatalog,
  listManualDocumentPackets,
  listManualDocuments,
  manualDocumentPacketPdfUrl,
  manualDocumentPdfUrl,
  searchPatientsForAttach,
  sendManualDocumentEmail,
  sendManualDocumentFax,
  sendManualDocumentPacketEmail,
  sendManualDocumentPacketFax,
  updateManualDocument,
  updateManualDocumentPacket,
  type ManualDocumentPacketDetail,
  type StandardDocumentPacketDef,
  type StandardDocumentTemplate,
  type ManualDocumentPacketStatus,
  type ManualDocumentPrefill,
  type ManualDocumentPacketSummary,
  type ManualDocumentStatus,
  type ManualDocumentSummary,
  type ManualDocumentType,
  type ManualDocumentTypeDef,
} from "@/lib/admin/manual-documents-api";
import { openPdfInNewTab, summarizePdfError } from "@/lib/admin/pdf-download";
import { sendErrorText } from "@/lib/admin/send-error";

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

const PACKET_STATUS_VARIANT: Record<ManualDocumentPacketStatus, BadgeVariant> =
  {
    draft: "muted",
    sent: "info",
  };

const PACKET_STATUS_LABEL: Record<ManualDocumentPacketStatus, string> = {
  draft: "Draft",
  sent: "Sent",
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
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [openPacketId, setOpenPacketId] = useState<string | null>(null);
  const [packetError, setPacketError] = useState<string | null>(null);
  // Row-level "PDF" links pre-flight the fetch (lib/admin/pdf-download)
  // so a render failure surfaces as a message here instead of raw JSON
  // in a new tab.
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [docPdfError, setDocPdfError] = useState<string | null>(null);
  const [packetPdfError, setPacketPdfError] = useState<string | null>(null);

  const openRowPdf = async (
    id: string,
    url: string,
    setError: (text: string | null) => void,
  ) => {
    setError(null);
    setPdfBusyId(id);
    try {
      const result = await openPdfInNewTab(url);
      if (!result.ok) {
        setError(
          `Couldn’t generate the PDF: ${summarizePdfError(result.error)}`,
        );
      }
    } finally {
      setPdfBusyId(null);
    }
  };

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

  const packetsQuery = useQuery({
    queryKey: ["manual-document-packets", "list"],
    queryFn: () => listManualDocumentPackets(),
  });
  const packets = packetsQuery.data?.packets ?? [];

  const refreshList = () =>
    qc.invalidateQueries({ queryKey: ["manual-documents", "list"] });
  const refreshPackets = () =>
    qc.invalidateQueries({ queryKey: ["manual-document-packets"] });

  const typeLabel = (t: ManualDocumentType) =>
    types.find((d) => d.type === t)?.label ?? t;

  const toggleChecked = (id: string) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Packet members follow the table's order, not the order the boxes
  // were ticked; ids checked under a different status filter (so not
  // currently listed) keep their tick order at the end.
  const orderedCheckedIds = (): string[] => {
    const ordered = documents
      .filter((d) => checkedIds.has(d.id))
      .map((d) => d.id);
    const seen = new Set(ordered);
    for (const id of checkedIds) if (!seen.has(id)) ordered.push(id);
    return ordered;
  };

  const createPacket = useMutation({
    mutationFn: (documentIds: string[]) =>
      createManualDocumentPacket({
        title: `Document packet — ${new Date().toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}`,
        documentIds,
      }),
    onSuccess: (res) => {
      setCheckedIds(new Set());
      setOpenPacketId(res.id);
      void refreshPackets();
    },
    onError: (err) =>
      setPacketError(describeError(err).detail ?? "Failed to create packet."),
  });

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
              cover by hand, then send each one on its own — or select several
              and send them together as a packet.
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

        {openPacketId && (
          <PacketEditor
            packetId={openPacketId}
            types={types}
            allDocuments={documents}
            checkedIds={checkedIds}
            onClearChecked={() => setCheckedIds(new Set())}
            onClose={() => setOpenPacketId(null)}
            onChanged={() => {
              void refreshPackets();
              void refreshList();
            }}
          />
        )}

        <StandardDocumentsPanel
          typeLabel={typeLabel}
          onCreated={(id) => {
            setComposing(false);
            setSelectedId(id);
            void refreshList();
          }}
          onPacketCreated={(id) => {
            setComposing(false);
            setOpenPacketId(id);
            void refreshPackets();
            void refreshList();
          }}
        />

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
          {checkedIds.size > 0 && (
            <div
              className="flex flex-wrap items-center gap-3 border-b px-5 py-3"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <span className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
                {checkedIds.size} selected
              </span>
              {!openPacketId && (
                <Button
                  size="sm"
                  isLoading={createPacket.isPending}
                  onClick={() => {
                    setPacketError(null);
                    createPacket.mutate(orderedCheckedIds());
                  }}
                >
                  Create packet from selected
                </Button>
              )}
              <Button
                intent="ghost"
                size="sm"
                onClick={() => setCheckedIds(new Set())}
              >
                Clear selection
              </Button>
              {packetError && (
                <span className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
                  {packetError}
                </span>
              )}
            </div>
          )}
          {docPdfError && (
            <div
              className="px-5 pt-3 text-sm"
              style={{ color: "hsl(0 70% 45%)" }}
            >
              {docPdfError}
            </div>
          )}
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
              hint="Click “New document” to type out a Certificate of Medical Necessity, prescription/order, agreement, delivery ticket, fax cover, or free-form letter. Each can be sent on its own or bundled into a packet."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    <th className="pl-5 pr-2 py-2 font-medium">
                      <span className="sr-only">Select</span>
                    </th>
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
                      <td className="pl-5 pr-2 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${d.title}`}
                          checked={checkedIds.has(d.id)}
                          onChange={() => toggleChecked(d.id)}
                        />
                      </td>
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
                        <button
                          type="button"
                          disabled={pdfBusyId === d.id}
                          onClick={() =>
                            void openRowPdf(
                              d.id,
                              manualDocumentPdfUrl(d.id),
                              setDocPdfError,
                            )
                          }
                          className="text-xs font-semibold mr-3 disabled:opacity-50"
                          style={{ color: "hsl(var(--penn-navy))" }}
                        >
                          {pdfBusyId === d.id ? "Opening…" : "PDF"}
                        </button>
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

        <Card
          title="Packets"
          subtitle="Bundles of the documents above, sent as one combined PDF — generated cover sheet first, then each document."
        >
          {packetPdfError && (
            <div
              className="px-5 pt-3 text-sm"
              style={{ color: "hsl(0 70% 45%)" }}
            >
              {packetPdfError}
            </div>
          )}
          {packetsQuery.isPending ? (
            <div className="p-6">
              <Spinner label="Loading packets…" />
            </div>
          ) : packetsQuery.isError ? (
            <div className="p-4">
              <ErrorPanel error={packetsQuery.error} />
            </div>
          ) : packets.length === 0 ? (
            <EmptyState
              title="No packets yet"
              hint="Tick the checkbox next to one or more documents above, then click “Create packet from selected” to bundle them."
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
                    <th className="px-5 py-2 font-medium">Documents</th>
                    <th className="px-5 py-2 font-medium">Status</th>
                    <th className="px-5 py-2 font-medium">Created</th>
                    <th className="px-5 py-2 font-medium text-right">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {packets.map((p: ManualDocumentPacketSummary) => (
                    <tr
                      key={p.id}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td className="px-5 py-3">
                        <div
                          className="font-medium"
                          style={{ color: "hsl(var(--ink-1))" }}
                        >
                          {p.title}
                        </div>
                        {p.recipient_name && (
                          <div
                            className="text-xs"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            To: {p.recipient_name}
                          </div>
                        )}
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {p.document_ids.length}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={PACKET_STATUS_VARIANT[p.status]}>
                          {PACKET_STATUS_LABEL[p.status]}
                        </Badge>
                      </td>
                      <td
                        className="px-5 py-3"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {fmtDate(p.created_at)}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={pdfBusyId === p.id}
                          onClick={() =>
                            void openRowPdf(
                              p.id,
                              manualDocumentPacketPdfUrl(p.id),
                              setPacketPdfError,
                            )
                          }
                          className="text-xs font-semibold mr-3 disabled:opacity-50"
                          style={{ color: "hsl(var(--penn-navy))" }}
                        >
                          {pdfBusyId === p.id ? "Opening…" : "PDF"}
                        </button>
                        <Button
                          intent="ghost"
                          size="sm"
                          onClick={() => setOpenPacketId(p.id)}
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

// ── Standard payer documents ──────────────────────────────────────
//
// The code-defined Medicare / insurance-payer template library (SWO,
// PAP CMN, ABN, AOB, supplier standards, proof of delivery, refill
// confirmation). Always listed for every staff member — "Use" creates
// an ordinary editable draft prefilled with the standard wording (no
// PHI; patient fields stay blank for "Prefill from chart").
function StandardDocumentsPanel({
  typeLabel,
  onCreated,
  onPacketCreated,
}: {
  typeLabel: (t: ManualDocumentType) => string;
  onCreated: (id: string) => void;
  onPacketCreated: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const catalogQuery = useQuery({
    queryKey: ["manual-documents", "standard-catalog"],
    queryFn: getStandardDocumentCatalog,
  });
  const templates = catalogQuery.data?.templates ?? [];
  const standardPackets = catalogQuery.data?.packets ?? [];

  const create = useMutation({
    mutationFn: (t: StandardDocumentTemplate) =>
      createManualDocument({
        documentType: t.documentType,
        title: t.title,
        fields: t.fields,
        body: t.body,
      }),
    onSuccess: (res) => {
      setPendingKey(null);
      onCreated(res.id);
    },
    onError: (err) => {
      setPendingKey(null);
      setError(describeError(err).detail ?? "Failed to create the document.");
    },
  });

  // Pure composition over the existing endpoints: one draft per member
  // template, then a packet bundling them in order. A failure partway
  // through leaves the already-created drafts visible in "All
  // documents" (deletable), never a half-hidden state.
  const createPacket = useMutation({
    mutationFn: async (p: StandardDocumentPacketDef) => {
      const documentIds: string[] = [];
      for (const key of p.templateKeys) {
        const t = templates.find((tpl) => tpl.key === key);
        if (!t) throw new Error(`Template “${key}” is missing.`);
        const res = await createManualDocument({
          documentType: t.documentType,
          title: t.title,
          fields: t.fields,
          body: t.body,
        });
        documentIds.push(res.id);
      }
      return createManualDocumentPacket({
        title: p.title,
        documentIds,
        includeCoverSheet: p.includeCoverSheet,
      });
    },
    onSuccess: (res) => {
      setPendingKey(null);
      onPacketCreated(res.id);
    },
    onError: (err) => {
      setPendingKey(null);
      setError(describeError(err).detail ?? "Failed to create the packet.");
    },
  });

  return (
    <Card
      title="Standard payer documents"
      subtitle="Medicare and insurance-compliant templates, available to everyone. “Use” creates an editable draft — patient fields stay blank until you fill them or prefill from a chart."
    >
      {catalogQuery.isPending ? (
        <div className="p-6">
          <Spinner label="Loading templates…" />
        </div>
      ) : catalogQuery.isError ? (
        <div className="p-4">
          <ErrorPanel error={catalogQuery.error} />
        </div>
      ) : (
        <div>
          {error && (
            <div
              className="border-b px-5 py-3 text-sm"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(0 70% 45%)",
              }}
            >
              {error}
            </div>
          )}
          <ul
            className="divide-y"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {templates.map((t) => (
              <li
                key={t.key}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0 flex-1" style={{ minWidth: "16rem" }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-sm font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {t.label}
                    </span>
                    <Badge variant="neutral">{typeLabel(t.documentType)}</Badge>
                  </div>
                  <p
                    className="mt-1 text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {t.description}
                  </p>
                </div>
                <Button
                  intent="secondary"
                  size="sm"
                  isLoading={create.isPending && pendingKey === t.key}
                  onClick={() => {
                    setError(null);
                    setPendingKey(t.key);
                    create.mutate(t);
                  }}
                >
                  Use
                </Button>
              </li>
            ))}
            {standardPackets.map((p) => (
              <li
                key={p.key}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0 flex-1" style={{ minWidth: "16rem" }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-sm font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {p.label}
                    </span>
                    <Badge variant="info">
                      Packet · {p.templateKeys.length} documents
                    </Badge>
                  </div>
                  <p
                    className="mt-1 text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {p.description}
                  </p>
                </div>
                <Button
                  intent="secondary"
                  size="sm"
                  isLoading={createPacket.isPending && pendingKey === p.key}
                  onClick={() => {
                    setError(null);
                    setPendingKey(p.key);
                    createPacket.mutate(p);
                  }}
                >
                  Create packet
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
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
          persist={persistDocument}
          onChanged={onSaved}
        />
      </div>
    </Card>
  );
}

// ── Prefill from a patient's chart ────────────────────────────────
//
// Opt-in: the operator picks a patient and the app suggests values from
// data already on file (demographics, latest prescription + provider,
// sleep-study diagnosis). The parent merges suggestions into BLANK
// inputs only — anything already typed is never overwritten.
function PrefillFromChart({
  documentType,
  onApply,
}: {
  documentType: ManualDocumentType;
  onApply: (prefill: ManualDocumentPrefill) => void;
}) {
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const patientsQuery = useQuery({
    queryKey: ["manual-documents", "prefill-search", search.trim()],
    queryFn: () => searchPatientsForAttach(search.trim()),
    enabled: search.trim().length >= 2,
  });

  const prefillMut = useMutation({
    mutationFn: (patientId: string) =>
      getManualDocumentPrefill({ patientId, documentType }),
    onSuccess: (prefill) => {
      onApply(prefill);
      setSearch("");
      setMsg({
        kind: "ok",
        text: "Filled from the chart — only blank inputs were filled; edit anything you like.",
      });
    },
    onError: (err) =>
      setMsg({
        kind: "err",
        text: describeError(err).detail ?? "Prefill failed.",
      }),
  });

  return (
    <div
      className="rounded-md border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <Label htmlFor="prefillSearch">Prefill from a patient’s chart</Label>
      <Input
        id="prefillSearch"
        placeholder="Search by name or Pacware ID…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setMsg(null);
        }}
      />
      {search.trim().length >= 2 && (
        <div
          className="rounded-md border divide-y max-h-48 overflow-y-auto"
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
                disabled={prefillMut.isPending}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-black/5"
                style={{ color: "hsl(var(--ink-1))" }}
                onClick={() => {
                  setMsg(null);
                  prefillMut.mutate(pt.id);
                }}
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

// ── Send / attach actions ─────────────────────────────────────────
function SendActions({
  documentId,
  defaultEmail,
  defaultFax,
  persist,
  onChanged,
}: {
  documentId: string;
  defaultEmail: string;
  defaultFax: string;
  persist: () => Promise<unknown>;
  onChanged: () => void;
}) {
  // The destination inputs mirror the Recipient block above (including
  // "Prefill from chart") until the operator types a different
  // destination here — then their override wins.
  const [emailOverride, setEmailOverride] = useState<string | null>(null);
  const [faxOverride, setFaxOverride] = useState<string | null>(null);
  const email = emailOverride ?? defaultEmail;
  const fax = faxOverride ?? defaultFax;
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // Send paths persist the form first so the emailed/faxed PDF always
  // matches what's typed in the editor above.
  const emailMut = useMutation({
    mutationFn: async () => {
      await persist();
      return sendManualDocumentEmail(documentId, { email: email.trim() });
    },
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved and emailed to the recipient." });
      onChanged();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: sendErrorText(err, "Email failed.") }),
  });

  const faxMut = useMutation({
    mutationFn: async () => {
      await persist();
      return sendManualDocumentFax(documentId, { fax: fax.trim() });
    },
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Saved and queued the fax." });
      onChanged();
    },
    onError: (err) =>
      setMsg({ kind: "err", text: sendErrorText(err, "Fax failed.") }),
  });

  const attachMut = useMutation({
    mutationFn: async (patientId: string) => {
      await persist();
      return attachManualDocument(documentId, { patientId });
    },
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
            onChange={(e) => setEmailOverride(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          isLoading={emailMut.isPending}
          onClick={() => {
            if (!email.trim()) {
              setMsg({ kind: "err", text: "Enter an email address first." });
              return;
            }
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
            onChange={(e) => setFaxOverride(e.target.value)}
          />
        </div>
        <Button
          intent="secondary"
          isLoading={faxMut.isPending}
          onClick={() => {
            if (!fax.trim()) {
              setMsg({ kind: "err", text: "Enter a fax number first." });
              return;
            }
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
      <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        “Email document”, “Send fax”, and “File to chart” save your edits first,
        so the PDF always matches what's typed above.
      </p>
    </div>
  );
}

// ── Packet editor ─────────────────────────────────────────────────
function PacketEditor({
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
              if (
                window.confirm(
                  "Delete this packet? The documents inside it are not deleted.",
                )
              ) {
                setMsg(null);
                del.mutate();
              }
            }}
          >
            Delete packet
          </Button>
        </div>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          “Email packet” and “Fax packet” save your edits first, then send to
          the email / fax number typed above.
        </p>
      </div>
    </Card>
  );
}

export default AdminDocumentsPage;
