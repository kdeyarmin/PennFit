// /admin/documents — staff-authored, manually-typed PDF documents.
//
// CSRs type out one-off documents (CMN, prescription/order, agreement,
// delivery ticket, fax cover letter, or a free-form letter) by hand,
// optionally prefilling blank inputs from a patient's chart (the
// "Prefill from chart" picker — nothing is ever filled silently), then
// download, email, fax, or file each one to a patient chart.
//
// This file is the page orchestrator; the panels/editors live in
// ./admin-documents/.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Select } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { formatAppDate } from "@/lib/utils";
import {
  createManualDocumentPacket,
  getManualDocumentCatalog,
  listManualDocumentPackets,
  listManualDocuments,
  manualDocumentPacketPdfUrl,
  manualDocumentPdfUrl,
  type ManualDocumentPacketSummary,
  type ManualDocumentStatus,
  type ManualDocumentSummary,
  type ManualDocumentType,
} from "@/lib/admin/manual-documents-api";
import { openPdfInNewTab, summarizePdfError } from "@/lib/admin/pdf-download";

import {
  PACKET_STATUS_LABEL,
  PACKET_STATUS_VARIANT,
  STATUS_LABEL,
  STATUS_VARIANT,
  fmtDate,
} from "./admin-documents/shared";
import { StandardDocumentsPanel } from "./admin-documents/standard-documents-panel";
import { NewDocumentPanel } from "./admin-documents/new-document-panel";
import { DocumentEditor } from "./admin-documents/document-editor";
import { PacketEditor } from "./admin-documents/packet-editor";

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
        title: `Document packet — ${formatAppDate(new Date(), {
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
              cover as a manual PDF for email, fax, download, or chart filing.
              For patient electronic signatures, send a Document packet.
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Link
              href="/admin/patient-packets"
              className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-semibold transition-all"
              style={{
                backgroundColor: "hsl(var(--surface-2))",
                color: "hsl(var(--penn-navy-deep))",
                borderColor: "hsl(var(--penn-gold))",
              }}
            >
              Send for e-sign
            </Link>
            <Button onClick={() => setComposing((s) => !s)}>
              {composing ? "Close" : "New document"}
            </Button>
          </div>
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
              hint="Click New document to type out a Certificate of Medical Necessity, prescription/order, agreement, delivery ticket, fax cover, or free-form letter. These manual PDFs can be emailed, faxed, downloaded, filed, or bundled into a combined PDF packet."
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
          subtitle="Bundles of the documents above, sent as one combined PDF for email, fax, download, or chart filing. This is not an electronic-signature packet."
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

export default AdminDocumentsPage;
