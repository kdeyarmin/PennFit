// useCartSnapshotSync — server-side mirror of useCart() for SIGNED-IN
// shop visitors only. Runs on every patient route via the
// <CartSnapshotSync /> mount in App.tsx.
//
// Behavior:
//   * Signed-out: no-op. Guests don't have a stable identity to email,
//     so there's nothing to mirror.
//   * Signed-in + items.length > 0: debounced PUT to
//     /resupply-api/shop/me/cart-snapshot 3s after the last change.
//   * Signed-in + items.length === 0: debounced DELETE.
//   * 401 response: silently disable for the rest of the session
//     (sign-in lost mid-page; nothing this hook can do about it).
//   * Network errors: best-effort, no toasts. The cart still persists
//     in localStorage; the snapshot is purely for the email nudge.
//
// Privacy: cart contents are public catalog data (Stripe IDs, names,
// qty). The server-side endpoint denormalizes the user's email at
// write time via the auth provider; the client never sends an email.
//
// Why a 3s debounce: matches typical "user keeps tweaking quantity"
// burst patterns. Long enough to coalesce a flurry of +/- clicks
// into one network round-trip; short enough that a real abandonment
// (close tab, walk away) gets recorded before the close.

import { useEffect, useRef } from "react";

import { useShopIdentity } from "@/lib/identity";
import { csrfHeader } from "@/lib/csrf";
import { useCart, type CartItem } from "./use-cart";

const DEBOUNCE_MS = 3000;
const SNAPSHOT_PATH = "/resupply-api/shop/me/cart-snapshot";

interface CartSnapshotItemPayload {
  priceId: string;
  productId: string;
  name: string;
  quantity: number;
  unitAmountCents: number;
  currency: string;
  mode: "one_time" | "subscription";
  recurringPriceId: string | null;
  recurringIntervalLabel: string | null;
  imageUrl: string | null;
  isBundle: boolean;
}

function toPayload(items: CartItem[]): {
  items: CartSnapshotItemPayload[];
  subtotalCents: number;
  currency: string;
} {
  const out: CartSnapshotItemPayload[] = items.map((it) => ({
    priceId: it.priceId,
    productId: it.productId,
    name: it.name,
    quantity: it.quantity,
    unitAmountCents: it.unitAmountCents,
    currency: it.currency,
    mode: it.mode,
    recurringPriceId: it.recurringPriceId,
    recurringIntervalLabel: it.recurringIntervalLabel,
    imageUrl: it.imageUrl,
    isBundle: it.isBundle,
  }));
  const subtotalCents = items.reduce(
    (sum, it) => sum + it.unitAmountCents * it.quantity,
    0,
  );
  // The cart can technically hold mixed currencies in pathological
  // catalogs; for v1 the shop is single-currency (USD). We pick the
  // first item's currency or fall back to "usd" for an empty cart.
  const currency = items[0]?.currency ?? "usd";
  return { items: out, subtotalCents, currency };
}

/**
 * Cheap structural compare so we don't re-PUT identical content
 * after a re-render that didn't actually change items.
 */
function signature(items: CartItem[]): string {
  return JSON.stringify(
    items
      .map((i) => ({
        p: i.priceId,
        q: i.quantity,
        m: i.mode,
        r: i.recurringPriceId,
      }))
      .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)),
  );
}

export function useCartSnapshotSync(): void {
  const { isSignedIn, isLoaded } = useShopIdentity();
  const { items } = useCart();

  const lastSentSig = useRef<string | null>(null);
  const disabled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // On sign-out (or 401), reset state so a future sign-in
      // re-syncs from scratch.
      lastSentSig.current = null;
      disabled.current = false;
      return;
    }
    if (disabled.current) return;

    const sig = signature(items);
    if (sig === lastSentSig.current) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void (async () => {
        try {
          if (items.length === 0) {
            const res = await fetch(SNAPSHOT_PATH, {
              method: "DELETE",
              credentials: "include",
              headers: { Accept: "application/json", ...csrfHeader() },
            });
            if (res.status === 401) {
              disabled.current = true;
              lastSentSig.current = null;
              return;
            }
            if (res.ok) lastSentSig.current = sig;
          } else {
            const body = toPayload(items);
            const res = await fetch(SNAPSHOT_PATH, {
              method: "PUT",
              credentials: "include",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...csrfHeader(),
              },
              body: JSON.stringify(body),
            });
            if (res.status === 401) {
              disabled.current = true;
              lastSentSig.current = null;
              return;
            }
            if (res.ok) lastSentSig.current = sig;
          }
        } catch {
          // Best-effort — never surface to the user.
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [isLoaded, isSignedIn, items]);
}

/**
 * Render-nothing wrapper so App.tsx can mount the sync without
 * restructuring the route tree.
 */
export function CartSnapshotSync(): null {
  useCartSnapshotSync();
  return null;
}
