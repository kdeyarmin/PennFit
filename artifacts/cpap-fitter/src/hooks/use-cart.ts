// useCart — localStorage-backed cart for the PennPaps cash-pay shop.
//
// Why localStorage (not server-backed):
//   The shop accepts anonymous visitors. Pushing a cart to the server
//   for an unauthenticated user would mean either (a) issuing a
//   guest-cart cookie + a writable cart table, or (b) requiring
//   sign-in before adding items. Both are friction the cash-pay
//   buyer doesn't need. Cards in the cart are public price IDs —
//   no PHI, no payment data; localStorage is fine.
//
// Cross-tab sync:
//   The `storage` event fires on OTHER tabs when a tab writes to
//   localStorage. We listen for it so opening the cart in a second
//   tab shows the same items the first tab is editing. We do NOT
//   broadcast on same-tab updates — those flow via React state.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "pennpaps_cart_v1";

export interface CartItem {
  productId: string;
  priceId: string;
  name: string;
  unitAmountCents: number;
  currency: string;
  quantity: number;
  imageUrl: string | null;
  isBundle: boolean;
}

function readStorage(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — discard entries that don't look right
    // rather than crashing the app on a malformed legacy entry.
    return parsed.filter(
      (it): it is CartItem =>
        !!it &&
        typeof it.productId === "string" &&
        typeof it.priceId === "string" &&
        typeof it.name === "string" &&
        typeof it.unitAmountCents === "number" &&
        typeof it.quantity === "number" &&
        it.quantity > 0,
    );
  } catch {
    return [];
  }
}

function writeStorage(items: CartItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota exceeded; cart simply doesn't persist this update */
  }
}

export function useCart(): {
  items: CartItem[];
  count: number;
  totalCents: number;
  addItem: (item: Omit<CartItem, "quantity">, quantity?: number) => void;
  setQuantity: (priceId: string, quantity: number) => void;
  removeItem: (priceId: string) => void;
  replaceItems: (items: CartItem[]) => void;
  clear: () => void;
} {
  const [items, setItems] = useState<CartItem[]>(() => readStorage());

  // Cross-tab sync: refresh from storage when another tab writes.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setItems(readStorage());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const persist = useCallback((next: CartItem[]) => {
    setItems(next);
    writeStorage(next);
  }, []);

  const addItem = useCallback(
    (item: Omit<CartItem, "quantity">, quantity = 1) => {
      setItems((current) => {
        const idx = current.findIndex((i) => i.priceId === item.priceId);
        let next: CartItem[];
        if (idx === -1) {
          next = [...current, { ...item, quantity }];
        } else {
          next = current.map((i, j) =>
            j === idx
              ? { ...i, quantity: Math.min(20, i.quantity + quantity) }
              : i,
          );
        }
        writeStorage(next);
        return next;
      });
    },
    [],
  );

  const setQuantity = useCallback((priceId: string, quantity: number) => {
    setItems((current) => {
      const next = current
        .map((i) =>
          i.priceId === priceId
            ? { ...i, quantity: Math.max(0, Math.min(20, quantity)) }
            : i,
        )
        .filter((i) => i.quantity > 0);
      writeStorage(next);
      return next;
    });
  }, []);

  const removeItem = useCallback((priceId: string) => {
    setItems((current) => {
      const next = current.filter((i) => i.priceId !== priceId);
      writeStorage(next);
      return next;
    });
  }, []);

  // Atomic swap of cart contents — used by "Buy this again" on the
  // account page to drop a past order's line items into the cart in
  // one go. Doing it as N sequential addItem() calls would trigger N
  // re-renders AND emit N cross-tab `storage` events, which other
  // tabs would then re-read individually; one write keeps it sane.
  // Defensively dedupes by priceId (a malformed past order with two
  // rows for the same SKU would otherwise become a phantom doubled
  // quantity in the cart).
  const replaceItems = useCallback(
    (next: CartItem[]) => {
      const dedup = new Map<string, CartItem>();
      for (const it of next) {
        const existing = dedup.get(it.priceId);
        if (existing) {
          existing.quantity = Math.min(20, existing.quantity + it.quantity);
        } else {
          dedup.set(it.priceId, {
            ...it,
            quantity: Math.max(1, Math.min(20, it.quantity)),
          });
        }
      }
      persist(Array.from(dedup.values()));
    },
    [persist],
  );

  const clear = useCallback(() => {
    persist([]);
  }, [persist]);

  const totalCents = items.reduce(
    (sum, i) => sum + i.unitAmountCents * i.quantity,
    0,
  );
  const count = items.reduce((sum, i) => sum + i.quantity, 0);

  return {
    items,
    count,
    totalCents,
    addItem,
    setQuantity,
    removeItem,
    replaceItems,
    clear,
  };
}
