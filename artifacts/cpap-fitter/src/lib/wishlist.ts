// Wishlist — client-only "save for later" list backed by
// localStorage. CPAP shoppers routinely price-compare two or
// three masks/cushions over multiple sessions before committing,
// and heart-to-save is the universal e-commerce affordance for
// that workflow. Keeping the list device-local (not synced to
// the account) is intentional v1: it works for signed-out
// shoppers, has no PHI/HIPAA implications, and ships with zero
// backend changes. We can promote to a server-synced list later
// if we ever want cross-device parity — the storage shape is
// versioned (`v1` in the key) so a future migration is cheap.
//
// We store ONLY the Stripe productId — never name/price/image,
// because the product catalog is the source of truth for those
// (they can change). The wishlist page resolves IDs against a
// fresh /shop/products fetch on each render so a shopper never
// sees a stale price or an out-of-stock chip from cache.
//
// Cross-tab/in-page subscribers are notified two ways:
//   - the standard `storage` event fires across other tabs
//   - a synthetic `wishlist:change` window event fires in the
//     same tab (storage events do NOT fire in the tab that
//     wrote the change, only in others — so the synthetic event
//     is what makes heart icons across the same page light up
//     and the header count badge update without a re-mount).

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "pennpaps:wishlist:v1";
const CHANGE_EVENT = "wishlist:change";
/**
 * Hard cap so a single shopper can't drive the storage value
 * to multiple kilobytes by mashing the heart icon. 200 is well
 * above what a real shopper would save and small enough that
 * the JSON write stays trivially fast.
 */
const MAX_ITEMS = 200;

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive filter — only keep non-empty strings, dedupe.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || item.length === 0) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out.slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Quota exceeded or storage disabled — the wishlist becomes a
    // no-op for this session, which is the right failure mode
    // (better than throwing into a click handler).
    return;
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getWishlist(): string[] {
  return read();
}

export function isInWishlist(productId: string): boolean {
  return read().includes(productId);
}

export function addToWishlist(productId: string): void {
  const current = read();
  if (current.includes(productId)) return;
  // Newest first — the wishlist page reads top-to-bottom in
  // recency order which matches what shoppers expect.
  write([productId, ...current].slice(0, MAX_ITEMS));
}

export function removeFromWishlist(productId: string): void {
  const current = read();
  const next = current.filter((id) => id !== productId);
  if (next.length === current.length) return;
  write(next);
}

/** Toggle membership and return the NEW state (true = now saved). */
export function toggleWishlist(productId: string): boolean {
  if (isInWishlist(productId)) {
    removeFromWishlist(productId);
    return false;
  }
  addToWishlist(productId);
  return true;
}

/**
 * React hook that subscribes to wishlist changes from any source
 * (this tab, other tabs, programmatic). Returns the live list
 * plus convenience helpers so call sites don't have to import
 * the imperative API.
 */
export function useWishlist() {
  const [ids, setIds] = useState<string[]>(() => read());

  useEffect(() => {
    const onChange = () => setIds(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setIds(read());
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const idSet = useMemo(() => new Set(ids), [ids]);
  const has = useCallback((id: string) => idSet.has(id), [idSet]);
  const toggle = useCallback((id: string) => toggleWishlist(id), []);
  const remove = useCallback((id: string) => removeFromWishlist(id), []);

  return { ids, count: ids.length, has, toggle, remove };
}
