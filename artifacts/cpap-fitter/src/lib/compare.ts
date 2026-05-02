// Compare list — localStorage-backed "stack" of up to 4 product
// IDs that the shopper has marked for side-by-side comparison.
// Common workflow on a CPAP catalog: shopper is choosing between
// two or three nasal-pillow cushions, or three full-face masks
// at slightly different price points, and wants to see the
// specs lined up next to each other.
//
// Mirrors the wishlist module (lib/wishlist.ts) almost exactly:
// versioned localStorage key, dedupe + cap, synthetic
// `compare:change` event so all subscribers in the same tab
// update without re-mounting, plus the standard cross-tab
// `storage` event.
//
// Why a separate list (not just "everything in the wishlist"):
// the wishlist is a shopper's longer-running save-for-later
// pile and can hold dozens of items; compare is a transient
// 2-4 item shortlist for the *next* purchase decision. They
// are distinct intents and conflating them on one storage key
// would degrade both.

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "pennpaps:compare:v1";
const CHANGE_EVENT = "compare:change";

/**
 * Hard cap on items in the compare drawer. Four columns is the
 * widest a side-by-side spec table can be on a typical desktop
 * before it stops being scannable; on mobile we'll show one
 * column per row regardless. Adding a 5th item bumps the oldest
 * out (FIFO).
 */
export const COMPARE_MAX = 4;

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string" || item.length === 0) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out.slice(0, COMPARE_MAX);
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getCompare(): string[] {
  return read();
}

export function isInCompare(productId: string): boolean {
  return read().includes(productId);
}

export function addToCompare(productId: string): void {
  const current = read();
  if (current.includes(productId)) return;
  // FIFO when the cap is hit — drop the oldest item to make
  // room for the new one. The shopper's most recent click
  // always sticks; the oldest click silently falls off.
  const next = [...current, productId].slice(-COMPARE_MAX);
  write(next);
}

export function removeFromCompare(productId: string): void {
  const current = read();
  const next = current.filter((id) => id !== productId);
  if (next.length === current.length) return;
  write(next);
}

export function clearCompare(): void {
  write([]);
}

/** Toggle membership and return the NEW state (true = now in list). */
export function toggleCompare(productId: string): boolean {
  if (isInCompare(productId)) {
    removeFromCompare(productId);
    return false;
  }
  addToCompare(productId);
  return true;
}

export function useCompare() {
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
  const toggle = useCallback((id: string) => toggleCompare(id), []);
  const remove = useCallback((id: string) => removeFromCompare(id), []);
  const clear = useCallback(() => clearCompare(), []);
  const isFull = ids.length >= COMPARE_MAX;

  return { ids, count: ids.length, has, toggle, remove, clear, isFull };
}
