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

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/track";

const STORAGE_KEY = "pennpaps_cart_v1";

export interface CartItem {
  productId: string;
  /**
   * One-time Stripe price ID for this SKU. This stays the cart's
   * stable key even when the user toggles "Subscribe & ship" — we
   * keep one logical line per SKU and only swap which price is
   * actually sent to checkout.
   */
  priceId: string;
  name: string;
  /**
   * Display unit amount, in cents. For v1 the subscribe price equals
   * the one-time price, so this is correct in both modes; if v2 ever
   * adds a discount, the cart will need a `recurringUnitAmountCents`
   * field too.
   */
  unitAmountCents: number;
  currency: string;
  quantity: number;
  imageUrl: string | null;
  isBundle: boolean;
  /**
   * "one_time" → checkout sends `priceId`. "subscription" → checkout
   * sends `recurringPriceId`. Defaults to "one_time" for legacy
   * localStorage rows that pre-date Subscribe & Save.
   */
  mode: "one_time" | "subscription";
  /**
   * Recurring (Stripe) price ID. Null when the SKU has no recurring
   * counterpart (e.g. masks). When null, the subscribe toggle is
   * hidden and `mode` is forced to "one_time" by setItemMode.
   */
  recurringPriceId: string | null;
  /** Pre-rendered cadence label like "month" or "3 months". */
  recurringIntervalLabel: string | null;
  /**
   * Snapshot of the SKU's stock count at add-to-cart time. Used by
   * `addItem` for a defense-in-depth check (the storefront should
   * already have hidden the button at zero stock, but admins can
   * change inventory between page load and add-click).
   *   * `null` → not tracked, treat as available.
   *   * `0`    → reject the add.
   * Subscriptions are exempt — see comment in `addItem`.
   */
  stockCount: number | null;
}

function readStorage(): { items: CartItem[]; droppedCount: number } {
  if (typeof window === "undefined") return { items: [], droppedCount: 0 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [], droppedCount: 0 };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { items: [], droppedCount: 0 };
    // Defensive shape check — discard entries that don't look right
    // rather than crashing the app on a malformed legacy entry.
    const valid = parsed.filter(
      (
        it,
      ): it is Partial<CartItem> & {
        productId: string;
        priceId: string;
        name: string;
        unitAmountCents: number;
        quantity: number;
      } =>
        !!it &&
        typeof it.productId === "string" &&
        typeof it.priceId === "string" &&
        typeof it.name === "string" &&
        typeof it.unitAmountCents === "number" &&
        typeof it.quantity === "number" &&
        it.quantity > 0,
    );
    const droppedCount = parsed.length - valid.length;
    return {
      droppedCount,
      items: valid.map(
        (it): CartItem => ({
          productId: it.productId,
          priceId: it.priceId,
          name: it.name,
          unitAmountCents: it.unitAmountCents,
          currency: typeof it.currency === "string" ? it.currency : "usd",
          quantity: it.quantity,
          imageUrl: typeof it.imageUrl === "string" ? it.imageUrl : null,
          isBundle: it.isBundle === true,
          // Backwards-compat: older localStorage rows have no `mode`
          // — treat them as one_time so existing carts don't surprise
          // anyone with a subscription on the next checkout.
          mode: it.mode === "subscription" ? "subscription" : "one_time",
          recurringPriceId:
            typeof it.recurringPriceId === "string"
              ? it.recurringPriceId
              : null,
          recurringIntervalLabel:
            typeof it.recurringIntervalLabel === "string"
              ? it.recurringIntervalLabel
              : null,
          // Backwards-compat: legacy rows have no `stockCount`. Treat
          // them as untracked (null) which preserves prior behaviour
          // — addItem only blocks at literal 0.
          stockCount: typeof it.stockCount === "number" ? it.stockCount : null,
        }),
      ),
    };
  } catch {
    return { items: [], droppedCount: 0 };
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
  /**
   * Add a SKU to the cart.
   *
   * Returns a discriminated result so the caller can surface the
   * "out of stock" outcome inline. Existing call sites that ignore
   * the return value remain valid — a successful add is still a
   * silent state mutation.
   */
  addItem: (
    item: Omit<CartItem, "quantity">,
    quantity?: number,
  ) =>
    | { ok: true }
    | { ok: false; reason: "out_of_stock" | "currency_mismatch" };
  setQuantity: (priceId: string, quantity: number) => void;
  setItemMode: (priceId: string, mode: "one_time" | "subscription") => void;
  removeItem: (priceId: string) => void;
  replaceItems: (items: CartItem[]) => void;
  clear: () => void;
} {
  const { toast } = useToast();

  // Capture the initial dropped count in a ref during the lazy state
  // initializer so we can notify after mount without calling readStorage twice.
  const initialDroppedRef = useRef(0);
  const [items, setItems] = useState<CartItem[]>(() => {
    const { items: stored, droppedCount } = readStorage();
    initialDroppedRef.current = droppedCount;
    return stored;
  });

  // Notify the user if any items were silently filtered on load.
  // Reset the ref to 0 after firing so React 18 StrictMode's
  // double-mount doesn't replay the toast twice on every dev page
  // load — same behavior in production where the mount fires once,
  // but quieter in dev.
  useEffect(() => {
    if (initialDroppedRef.current > 0) {
      const count = initialDroppedRef.current;
      initialDroppedRef.current = 0;
      toast({
        title: "Some cart items were removed",
        description: "Some cart items were removed because they're no longer available.",
      });
      track("cart_items_dropped", { count });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync: refresh from storage when another tab writes.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        const { items: next, droppedCount } = readStorage();
        setItems(next);
        if (droppedCount > 0) {
          toast({
            title: "Some cart items were removed",
            description: "Some cart items were removed because they're no longer available.",
          });
          track("cart_items_dropped", { count: droppedCount });
        }
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [toast]);

  const persist = useCallback((next: CartItem[]) => {
    setItems(next);
    writeStorage(next);
  }, []);

  const addItem = useCallback(
    (item: Omit<CartItem, "quantity">, quantity = 1) => {
      // Defense in depth: the storefront cards / detail page should
      // already hide the Add button at zero stock, but inventory can
      // change between page load and click. Subscription mode is
      // exempt — auto-ship inventory is replenished separately
      // (per the project lock note in the session plan).
      if (
        item.mode !== "subscription" &&
        typeof item.stockCount === "number" &&
        item.stockCount <= 0
      ) {
        return { ok: false as const, reason: "out_of_stock" as const };
      }
      // Refuse to mix currencies inside one cart. totalCents sums
      // unitAmountCents across all items regardless of currency, so a
      // single non-USD price slipping into the catalog would silently
      // produce a wrong checkout total. v1 is USD-only by policy;
      // surface a typed reason instead of silently letting the bug
      // through if a future price lands on a different currency.
      // Mismatch check uses the freshest items via the setter below.
      let currencyMismatch = false;
      setItems((current) => {
        // Currency check uses the freshest `current` from React
        // rather than a closure-captured snapshot. Refuse to add an
        // item whose currency differs from any existing item.
        if (current.some((i) => i.currency !== item.currency)) {
          currencyMismatch = true;
          return current;
        }
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
      if (currencyMismatch) {
        return { ok: false as const, reason: "currency_mismatch" as const };
      }
      return { ok: true as const };
    },
    [],
  );

  const setQuantity = useCallback((priceId: string, quantity: number) => {
    // Clamp + integerize. Math.floor guards against any caller that
    // forwards a fractional input (e.g. a number-input change handler
    // that briefly emits 1.5 mid-keystroke) — Stripe rejects fractional
    // line-item quantities, so it's worth catching here on entry rather
    // than failing at checkout.
    const safeQty = Math.floor(
      Math.max(0, Math.min(20, Number.isFinite(quantity) ? quantity : 0)),
    );
    setItems((current) => {
      const next = current
        .map((i) => (i.priceId === priceId ? { ...i, quantity: safeQty } : i))
        .filter((i) => i.quantity > 0);
      writeStorage(next);
      return next;
    });
  }, []);

  // Toggle one cart line between one-time and subscription. We only
  // honor "subscription" if the line actually carries a
  // recurringPriceId — silently coercing a non-recurring SKU back to
  // "one_time" keeps the checkout payload always valid.
  const setItemMode = useCallback(
    (priceId: string, mode: "one_time" | "subscription") => {
      setItems((current) => {
        const next: CartItem[] = current.map((i) => {
          if (i.priceId !== priceId) return i;
          const nextMode: CartItem["mode"] =
            mode === "subscription" && i.recurringPriceId
              ? "subscription"
              : "one_time";
          return { ...i, mode: nextMode };
        });
        writeStorage(next);
        return next;
      });
    },
    [],
  );

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
    setItemMode,
    removeItem,
    replaceItems,
    clear,
  };
}
