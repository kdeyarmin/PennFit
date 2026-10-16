// The setup's machine is the E0601 line on its signature order, and
// the fulfillment of that line. Another shipment on the same chart
// does not count.

export interface OrderItemLike {
  sku?: string;
  description?: string;
}

export interface SetupOrderCandidate {
  id: string;
  status: string;
  created_at: string;
  items: unknown;
}

export function parseOrderItems(items: unknown): OrderItemLike[] {
  if (!Array.isArray(items)) return [];
  const parsed: OrderItemLike[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { sku?: unknown; description?: unknown };
    parsed.push({
      sku: typeof row.sku === "string" ? row.sku : undefined,
      description:
        typeof row.description === "string" ? row.description : undefined,
    });
  }
  return parsed;
}

export function isE0601Item(item: OrderItemLike): boolean {
  if (item.sku?.trim().toUpperCase() === "E0601") return true;
  return /\bE0601\b/i.test(item.description ?? "");
}

export function orderHasE0601(items: unknown): boolean {
  return parseOrderItems(items).some(isE0601Item);
}

export function isMachineFulfillment(
  itemSku: string | null | undefined,
  items: unknown,
): boolean {
  const sku = itemSku?.trim();
  if (!sku) return false;
  if (/^E0601$/i.test(sku)) return true;
  return parseOrderItems(items).some(
    (item) => isE0601Item(item) && item.sku?.trim() === sku,
  );
}

/**
 * The linked order wins while it is still live and is an E0601 order.
 * Otherwise exactly one E0601 order opened with the setup is used.
 * Two candidates stay unlinked rather than guessing.
 */
export function chooseSetupOrder(input: {
  linkedOrderId: string | null;
  openedAt: string;
  orders: SetupOrderCandidate[];
}): string | null {
  const live = input.orders.filter(
    (order) => order.status !== "canceled" && orderHasE0601(order.items),
  );
  const linked = live.find((order) => order.id === input.linkedOrderId);
  if (linked) return linked.id;
  const opened = Date.parse(input.openedAt);
  const candidates = live.filter((order) => {
    const created = Date.parse(order.created_at);
    return (
      Number.isFinite(opened) && Number.isFinite(created) && created >= opened
    );
  });
  return candidates.length === 1 ? candidates[0]!.id : null;
}
