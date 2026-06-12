// /admin/documents — Standard payer documents panel.
//
// The code-defined Medicare / insurance-payer template library (SWO,
// PAP CMN, ABN, AOB, supplier standards, proof of delivery, refill
// confirmation). Always listed for every staff member — "Use" creates
// an ordinary editable draft prefilled with the standard wording (no
// PHI; patient fields stay blank for "Prefill from chart").

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import {
  createManualDocument,
  createManualDocumentPacket,
  getStandardDocumentCatalog,
  type StandardDocumentPacketDef,
  type StandardDocumentTemplate,
  type ManualDocumentType,
} from "@/lib/admin/manual-documents-api";

export function StandardDocumentsPanel({
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
