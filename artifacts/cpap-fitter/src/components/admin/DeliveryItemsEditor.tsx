import { useState } from "react";

import type {
  PacketDeliveryDetails,
  PacketDeliveryItem,
} from "@workspace/api-client-react/admin";
import { Button } from "@/components/admin/Button";
import { Input, Label } from "@/components/admin/Input";
import { HcpcsCodeAutocomplete } from "@/components/admin/HcpcsCodeAutocomplete";

// Editor for a packet's itemized Proof of Delivery snapshot — the
// equipment line items (description, HCPCS, quantity) plus the delivery
// date, address, and order reference that CMS expects on a compliant
// POD. Used in the "Send packet" flow and when editing an open packet.
//
// Uncontrolled-with-onChange: it seeds its own editing state from
// `initialValue` once and emits a normalized `PacketDeliveryDetails`
// (or null when everything is blank) on every keystroke. The parent
// stores whatever it last received and submits that.

interface EditRow {
  description: string;
  hcpcs: string;
  quantity: string;
}

interface EditState {
  items: EditRow[];
  deliveryDate: string;
  deliveryAddress: string;
  orderRef: string;
}

const EMPTY_ROW: EditRow = { description: "", hcpcs: "", quantity: "" };

function seed(initial: PacketDeliveryDetails | null | undefined): EditState {
  return {
    items:
      initial?.items && initial.items.length > 0
        ? initial.items.map((it) => ({
            description: it.description ?? "",
            hcpcs: it.hcpcs ?? "",
            quantity: it.quantity != null ? String(it.quantity) : "",
          }))
        : [{ ...EMPTY_ROW }],
    deliveryDate: initial?.deliveryDate ?? "",
    deliveryAddress: initial?.deliveryAddress ?? "",
    orderRef: initial?.orderRef ?? "",
  };
}

function normalize(state: EditState): PacketDeliveryDetails | null {
  const items: PacketDeliveryItem[] = state.items
    .map((r) => {
      const description = r.description.trim();
      const qty = Number.parseInt(r.quantity, 10);
      return {
        description,
        hcpcs: r.hcpcs.trim() || null,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
      };
    })
    .filter((r) => r.description.length > 0);

  const dd: PacketDeliveryDetails = {};
  if (items.length > 0) dd.items = items;
  if (state.deliveryDate.trim()) dd.deliveryDate = state.deliveryDate.trim();
  if (state.deliveryAddress.trim())
    dd.deliveryAddress = state.deliveryAddress.trim();
  if (state.orderRef.trim()) dd.orderRef = state.orderRef.trim();
  return Object.keys(dd).length > 0 ? dd : null;
}

export function DeliveryItemsEditor({
  idPrefix,
  initialValue,
  onChange,
}: {
  /** Unique prefix so the field ids don't collide when two editors mount. */
  idPrefix: string;
  initialValue?: PacketDeliveryDetails | null;
  onChange: (value: PacketDeliveryDetails | null) => void;
}) {
  const [state, setState] = useState<EditState>(() => seed(initialValue));

  const apply = (next: EditState) => {
    setState(next);
    onChange(normalize(next));
  };

  const setItem = (i: number, patch: Partial<EditRow>) =>
    apply({
      ...state,
      items: state.items.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    });

  const addRow = () =>
    apply({ ...state, items: [...state.items, { ...EMPTY_ROW }] });

  const removeRow = (i: number) =>
    apply({
      ...state,
      items:
        state.items.length > 1
          ? state.items.filter((_, idx) => idx !== i)
          : [{ ...EMPTY_ROW }],
    });

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor={`${idPrefix}-item-0-desc`}>Equipment delivered</Label>
        <p className="text-xs mb-2" style={{ color: "hsl(var(--ink-3))" }}>
          Itemize what was delivered for the Proof of Delivery. Leave blank if
          this packet has no delivery yet.
        </p>
        <div className="space-y-2">
          {state.items.map((row, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[12rem]">
                <Label htmlFor={`${idPrefix}-item-${i}-desc`}>
                  <span className="sr-only">Item {i + 1} description</span>
                </Label>
                <Input
                  id={`${idPrefix}-item-${i}-desc`}
                  placeholder="Description, e.g. ResMed AirSense 11 CPAP"
                  value={row.description}
                  onChange={(e) => setItem(i, { description: e.target.value })}
                />
              </div>
              <div className="w-28">
                <Label htmlFor={`${idPrefix}-item-${i}-hcpcs`}>
                  <span className="sr-only">Item {i + 1} HCPCS</span>
                </Label>
                <HcpcsCodeAutocomplete
                  id={`${idPrefix}-item-${i}-hcpcs`}
                  placeholder="HCPCS"
                  value={row.hcpcs}
                  onValueChange={(v) => setItem(i, { hcpcs: v })}
                />
              </div>
              <div className="w-20">
                <Label htmlFor={`${idPrefix}-item-${i}-qty`}>
                  <span className="sr-only">Item {i + 1} quantity</span>
                </Label>
                <Input
                  id={`${idPrefix}-item-${i}-qty`}
                  type="number"
                  min={1}
                  max={999}
                  placeholder="Qty"
                  value={row.quantity}
                  onChange={(e) => setItem(i, { quantity: e.target.value })}
                />
              </div>
              <Button
                type="button"
                intent="ghost"
                size="sm"
                onClick={() => removeRow(i)}
                aria-label={`Remove item ${i + 1}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          intent="ghost"
          size="sm"
          className="mt-2"
          onClick={addRow}
        >
          + Add item
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor={`${idPrefix}-deliveryDate`}>Delivery date</Label>
          <Input
            id={`${idPrefix}-deliveryDate`}
            type="date"
            value={state.deliveryDate}
            onChange={(e) => apply({ ...state, deliveryDate: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-orderRef`}>Order reference</Label>
          <Input
            id={`${idPrefix}-orderRef`}
            placeholder="e.g. SO-10482"
            value={state.orderRef}
            onChange={(e) => apply({ ...state, orderRef: e.target.value })}
          />
        </div>
        <div className="sm:col-span-3">
          <Label htmlFor={`${idPrefix}-deliveryAddress`}>Delivered to</Label>
          <Input
            id={`${idPrefix}-deliveryAddress`}
            placeholder="Delivery address"
            value={state.deliveryAddress}
            onChange={(e) =>
              apply({ ...state, deliveryAddress: e.target.value })
            }
          />
        </div>
      </div>
    </div>
  );
}

export default DeliveryItemsEditor;
