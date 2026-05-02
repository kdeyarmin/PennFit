// useRecentlyViewed — localStorage-backed list of product ids the
// shopper has opened on the PDP. Surfaces "Recently viewed" strips
// on /shop and at the bottom of the PDP so a shopper can re-find
// what they were looking at without navigating back through filters.
//
// Why localStorage (not server-backed):
//   The shop accepts anonymous visitors, and a "recently viewed"
//   list is a nicety, not a hard requirement. Pushing it to the
//   server would mean either a guest cookie + a writable table, or
//   forcing sign-in. Both are friction the cash-pay buyer doesn't
//   need. The list is just Stripe product ids — no PHI, no payment
//   data; localStorage is fine.
//
// Cross-tab sync:
//   The `storage` event fires on OTHER tabs when a tab writes to
//   localStorage. We listen for it so opening a second tab shows
//   the same list the first tab just updated. Same-tab updates
//   flow via React state.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "pennpaps_recently_viewed_v1";
const MAX_ITEMS = 12;

function readStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defense in depth: filter out anything that doesn't look like a
    // Stripe product id so a corrupted localStorage payload can't
    // surface arbitrary strings into the UI.
    return parsed
      .filter(
        (v): v is string =>
          typeof v === "string" && /^prod_[A-Za-z0-9_-]+$/.test(v),
      )
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function writeStorage(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage can throw in private modes / quota-exceeded.
    // We swallow — recently-viewed is a nicety, not a hard requirement.
  }
}

export interface UseRecentlyViewed {
  /** Most-recent first. Capped at 12. */
  productIds: string[];
  /** Move (or insert) a product id to the head of the list. */
  recordView: (productId: string) => void;
  /** Clear all entries. */
  clear: () => void;
}

export function useRecentlyViewed(): UseRecentlyViewed {
  const [productIds, setProductIds] = useState<string[]>(() => readStorage());

  // Cross-tab sync: another tab pushed an update, mirror it here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setProductIds(readStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const recordView = useCallback((productId: string) => {
    // Accept Stripe live ids (`prod_<base62>`) AND our preview-mode ids
    // which look like `prod_preview_mask-nasal-pillows-medium` — i.e.
    // also allow underscore and hyphen after the prefix. We deliberately
    // keep the `prod_` prefix gate so a corrupted localStorage payload
    // can't surface arbitrary strings into the UI.
    if (!productId || !/^prod_[A-Za-z0-9_-]+$/.test(productId)) return;
    // Read the latest list from localStorage rather than from React
    // state. This avoids two pitfalls:
    //   1. Stale-closure: a sibling tab may have written between
    //      mount and now; `prev` would not see those updates.
    //   2. Strict-mode double invocation of the setState callback in
    //      dev — if writeStorage ran in there, the second call would
    //      no-op against the (now-mutated) `prev` and lose entries.
    // We compute the next list once, write it, then sync state.
    const current = readStorage();
    const without = current.filter((id) => id !== productId);
    const next = [productId, ...without].slice(0, MAX_ITEMS);
    writeStorage(next);
    setProductIds(next);
  }, []);

  const clear = useCallback(() => {
    setProductIds([]);
    writeStorage([]);
  }, []);

  return { productIds, recordView, clear };
}

/** Test-only export so vitest can clear state between cases. */
export const _RECENTLY_VIEWED_STORAGE_KEY = STORAGE_KEY;
export const _RECENTLY_VIEWED_MAX = MAX_ITEMS;
