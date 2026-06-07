import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  usePatientPacket,
  usePatientPacketTemplates,
  useUpdatePatientPacket,
  getPatientPacketQueryKey,
  type PacketDeliveryDetails,
} from "@workspace/api-client-react/admin";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel, describeError } from "@/components/admin/ErrorPanel";
import { DeliveryItemsEditor } from "@/components/admin/DeliveryItemsEditor";

// Edit form for an open (unsigned) packet: change the title, the
// document set, and the itemized Proof of Delivery snapshot. Fetches the
// packet's current detail to seed its fields, then PATCHes the changes.
// Shared by the standalone Document Packets page and the per-patient
// Document packets tab so the two never drift.
export function PacketEditForm({
  packetId,
  onSaved,
  onCancel,
}: {
  packetId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const detailQuery = usePatientPacket(packetId);
  const templatesQuery = usePatientPacketTemplates();
  const update = useUpdatePatientPacket();

  const [title, setTitle] = useState("");
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [delivery, setDelivery] = useState<PacketDeliveryDetails | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = templatesQuery.data?.templates ?? [];

  // Seed the fields once both the packet detail and the template catalog
  // have loaded (so we know which documents are currently included).
  useEffect(() => {
    if (seeded) return;
    const detail = detailQuery.data;
    const list = templatesQuery.data?.templates;
    if (!detail || !list || list.length === 0) return;
    setTitle(detail.packet.title);
    const included = new Set(detail.documents.map((d) => d.document_key));
    const next: Record<string, boolean> = {};
    for (const t of list) next[t.key] = included.has(t.key);
    setKeys(next);
    setDelivery(detail.packet.delivery_details);
    setSeeded(true);
  }, [detailQuery.data, templatesQuery.data, seeded]);

  if (detailQuery.isPending || templatesQuery.isPending || !seeded) {
    return (
      <div
        className="rounded-md border p-4"
        style={{ borderColor: "hsl(var(--penn-navy) / 0.30)" }}
      >
        <Spinner label="Loading packet…" />
      </div>
    );
  }
  if (detailQuery.isError) {
    return (
      <div
        className="rounded-md border p-4"
        style={{ borderColor: "hsl(var(--penn-navy) / 0.30)" }}
      >
        <ErrorPanel error={detailQuery.error} />
      </div>
    );
  }

  const chosenKeys = templates
    .filter((t) => t.required || keys[t.key])
    .map((t) => t.key);

  const save = async () => {
    setError(null);
    if (chosenKeys.length === 0) {
      setError("Select at least one document.");
      return;
    }
    try {
      await update.mutateAsync({
        packetId,
        data: {
          documentKeys: chosenKeys,
          title: title.trim() || undefined,
          deliveryDetails: delivery,
        },
      });
      void qc.invalidateQueries({
        queryKey: getPatientPacketQueryKey(packetId),
      });
      onSaved();
    } catch (err) {
      setError(describeError(err).detail ?? "Failed to update packet.");
    }
  };

  return (
    <div
      className="rounded-md border p-4 space-y-4"
      style={{ borderColor: "hsl(var(--penn-navy) / 0.30)" }}
    >
      <h3
        className="text-sm font-semibold"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        Edit packet
      </h3>

      <div>
        <Label htmlFor={`pkt-edit-title-${packetId}`}>Title</Label>
        <Input
          id={`pkt-edit-title-${packetId}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div>
        <Label htmlFor={`pkt-edit-docs-${packetId}`}>Documents</Label>
        <div className="space-y-2" id={`pkt-edit-docs-${packetId}`}>
          {templates.map((t) => (
            <label
              key={t.key}
              className="flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={t.required || Boolean(keys[t.key])}
                disabled={t.required}
                onChange={() =>
                  setKeys((k) => ({ ...k, [t.key]: !k[t.key] }))
                }
              />
              <span>
                <span
                  className="font-medium text-sm"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {t.title}
                </span>{" "}
                {t.required ? (
                  <Badge variant="info">Required</Badge>
                ) : !t.requiresSignature ? (
                  <Badge variant="muted">Informational</Badge>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label htmlFor={`pkt-edit-${packetId}-item-0-desc`}>
          Itemized Proof of Delivery
        </Label>
        <DeliveryItemsEditor
          idPrefix={`pkt-edit-${packetId}`}
          initialValue={detailQuery.data.packet.delivery_details}
          onChange={setDelivery}
        />
      </div>

      {error && (
        <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={save} isLoading={update.isPending}>
          Save changes
        </Button>
        <Button intent="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default PacketEditForm;
