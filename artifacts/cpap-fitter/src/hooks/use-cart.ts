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
// Why a shared module-level store (not per-component useState):
//   useCart() is read by MANY components at once — the always-mounted
//   header MiniCart, the cart page, every product card, the quick-view
//   dialog, and the signed-in snapshot sync. A plain `useState` inside
//   the hook gives each of those an ISOLATED copy of the cart, so
//   "Add to cart" in one component never re-renders the others — the
//   header badge stayed empty even though the item was persisted. The
//   browser `storage` event can't bridge them either: it fires only in
//   OTHER tabs, never the tab that wrote the value. The fix is a single
//   module-level store read through useSyncExternalStore: every
//   consumer shares one snapshot and re-renders on any mutation, in the
//   same tab. localStorage remains the durable backing store, and the
//   `storage` event still syncs across tabs (handled once, below).

import { useEffect, useSyncExternalStore } from "react";
import { toast } from "@/hooks/use-toast";
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
    // Currency uniqueness: addItem enforces a single currency per cart
    // (totalCents sums unitAmountCents regardless of currency, so a
    // mixed-currency cart silently mis-totals at checkout). Apply the
    // same invariant on READ so a corrupted localStorage row, a manual
    // edit, or a cross-tab race can't reintroduce a mismatch. Keep the
    // first-seen currency; drop everything else.
    let firstCurrency: string | null = null;
    const currencyFiltered = valid.filter((it) => {
      const c = typeof it.currency === "string" ? it.currency : "usd";
      if (firstCurrency === null) {
        firstCurrency = c;
        return true;
      }
      return c === firstCurrency;
    });
    const droppedCount = parsed.length - currencyFiltered.length;
    return {
      droppedCount,
      items: currencyFiltered.map(
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

// ---------------------------------------------------------------------------
// Module-level store — the single source of truth shared by every
// useCart() consumer. `state` is a stable reference that only changes
// (to a brand-new array) on a mutation, so useSyncExternalStore's
// getSnapshot can hand it back without tripping the "snapshot keeps
// changing" guard.
// ---------------------------------------------------------------------------

// Initialised once, eagerly, at module load. Reading localStorage here
// (rather than lazily inside getSnapshot) keeps getSnapshot pure and
// side-effect-free during render.
const initial = readStorage();
let state: CartItem[] = initial.items;

// Drops detected at load time (corrupted / mixed-currency rows). Surfaced
// once, from the first mounted consumer's effect — see useCart below.
let pendingDroppedCount = initial.droppedCount;

// Stable empty reference for the SSR/non-browser snapshot. Returning a
// fresh [] each call would make useSyncExternalStore loop.
const EMPTY: CartItem[] = [];

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Apply a mutation: swap in the new array, persist, notify. */
function commit(next: CartItem[]): void {
  state = next;
  writeStorage(next);
  emit();
}

function notifyDropped(count: number): void {
  if (count <= 0) return;
  toast({
    title: "Some cart items were removed",
    description:
      "Some cart items were removed because they couldn't be added to your cart.",
  });
  track("cart_items_dropped", { count });
}

// Cross-tab sync: when ANOTHER tab writes the cart, refresh from
// storage. We adopt the new array directly (no writeStorage — it's
// already in localStorage) and notify all in-tab consumers. Attached
// once, on the first subscribe, and left for the app's lifetime.
let storageListenerAttached = false;
function onStorageEvent(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY) return;
  const { items, droppedCount } = readStorage();
  state = items;
  emit();
  notifyDropped(droppedCount);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", onStorageEvent);
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CartItem[] {
  return state;
}

function getServerSnapshot(): CartItem[] {
  return EMPTY;
}

type AddResult =
  | { ok: true }
  | { ok: false; reason: "out_of_stock" | "currency_mismatch" };

function addItem(item: Omit<CartItem, "quantity">, quantity = 1): AddResult {
  // Defense in depth: the storefront cards / detail page should
  // already hide the Add button at zero stock, but inventory can
  // change between page load and click. Subscription mode is exempt
  // — auto-ship inventory is replenished separately.
  if (
    item.mode !== "subscription" &&
    typeof item.stockCount === "number" &&
    item.stockCount <= 0
  ) {
    return { ok: false, reason: "out_of_stock" };
  }
  // Refuse to mix currencies inside one cart. totalCents sums
  // unitAmountCents across all items regardless of currency, so a
  // single non-USD price slipping into the catalog would silently
  // produce a wrong checkout total. v1 is USD-only by policy; surface
  // a typed reason instead of letting the bug through. `state` is
  // always the freshest cart, so no stale-closure dance is needed.
  if (state.some((i) => i.currency !== item.currency)) {
    return { ok: false, reason: "currency_mismatch" };
  }
  const idx = state.findIndex((i) => i.priceId === item.priceId);
  const next =
    idx === -1
      ? [...state, { ...item, quantity }]
      : state.map((i, j) =>
          j === idx
            ? { ...i, quantity: Math.min(20, i.quantity + quantity) }
            : i,
        );
  commit(next);
  return { ok: true };
}

function setQuantity(priceId: string, quantity: number): void {
  // Clamp + integerize. Math.floor guards against any caller that
  // forwards a fractional input (e.g. a number-input change handler
  // that briefly emits 1.5 mid-keystroke) — Stripe rejects fractional
  // line-item quantities, so it's worth catching here on entry rather
  // than failing at checkout.
  const safeQty = Math.floor(
    Math.max(0, Math.min(20, Number.isFinite(quantity) ? quantity : 0)),
  );
  const next = state
    .map((i) => (i.priceId === priceId ? { ...i, quantity: safeQty } : i))
    .filter((i) => i.quantity > 0);
  commit(next);
}

// Toggle one cart line between one-time and subscription. We only
// honor "subscription" if the line actually carries a
// recurringPriceId — silently coercing a non-recurring SKU back to
// "one_time" keeps the checkout payload always valid.
function setItemMode(priceId: string, mode: "one_time" | "subscription"): void {
  const next: CartItem[] = state.map((i) => {
    if (i.priceId !== priceId) return i;
    const nextMode: CartItem["mode"] =
      mode === "subscription" && i.recurringPriceId
        ? "subscription"
        : "one_time";
    return { ...i, mode: nextMode };
  });
  commit(next);
}

function removeItem(priceId: string): void {
  commit(state.filter((i) => i.priceId !== priceId));
}

// Atomic swap of cart contents — used by "Buy this again" on the
// account page to drop a past order's line items into the cart in one
// go. Doing it as N sequential addItem() calls would trigger N
// re-renders AND emit N cross-tab `storage` events. Defensively
// dedupes by priceId (a malformed past order with two rows for the
// same SKU would otherwise become a phantom doubled quantity).
function replaceItems(next: CartItem[]): void {
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
  commit(Array.from(dedup.values()));
}

function clear(): void {
  commit([]);
}

/**
 * Vanilla (non-React) handle on the shared cart store. Exposed so
 * imperative callers outside the React tree can read and mutate the
 * cart — e.g. sign-out clears it from `lib/identity.tsx` so a shared
 * device doesn't bleed one user's cart into the next session — and so
 * the store's behaviour is unit-testable without a DOM. React
 * components should use the `useCart()` hook instead.
 */
export const cartStore = {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  addItem,
  setQuantity,
  setItemMode,
  removeItem,
  replaceItems,
  clear,
};

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
  addItem: (item: Omit<CartItem, "quantity">, quantity?: number) => AddResult;
  setQuantity: (priceId: string, quantity: number) => void;
  setItemMode: (priceId: string, mode: "one_time" | "subscription") => void;
  removeItem: (priceId: string) => void;
  replaceItems: (items: CartItem[]) => void;
  clear: () => void;
} {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Surface any items dropped at load time (corrupted / mixed-currency
  // rows). Drain the shared counter so exactly one consumer fires the
  // toast — not once per mounted useCart() — and so React 19
  // StrictMode's double-mount doesn't replay it. Cross-tab drops are
  // surfaced separately, from onStorageEvent.
  useEffect(() => {
    if (pendingDroppedCount > 0) {
      const count = pendingDroppedCount;
      pendingDroppedCount = 0;
      notifyDropped(count);
    }
  }, []);

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
