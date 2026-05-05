// Customer-side parts-finder filter hook (Phase F.1, layered on
// Phase B.3's compatibility data + Phase 1's saved device profile).
//
// Returns a filter predicate the catalog page applies to its
// product list — render the toggle component only when the
// customer is signed in AND has a device on file.

import { useCallback, useEffect, useState } from "react";

import {
  AccountApiError,
  fetchShopClinicalInfo,
  type CpapDeviceInfo,
} from "@/lib/account-api";
import {
  buildCompatibilityFilter,
  fetchCompatibilityForMachine,
} from "@/lib/product-compatibility-api";

export interface UseMachineFilter {
  /** The customer's saved device, null if none on file or guest. */
  device: CpapDeviceInfo | null;
  /** Whether the user has flipped the toggle on. */
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** True while the compatibility map is being fetched. */
  loading: boolean;
  /** Apply this to any product list to keep only compatible +
   *  universal products. No-op when the filter isn't enabled. */
  filter: <T extends { id: string }>(products: T[]) => T[];
}

export function useMachineFilter(): UseMachineFilter {
  const [device, setDevice] = useState<CpapDeviceInfo | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  // Pre-built predicate that closes over the compatibility Sets so
  // they aren't re-allocated on every filter call. Null until the
  // first successful fetch.
  const [compatPredicate, setCompatPredicate] = useState<
    ((id: string) => boolean) | null
  >(null);

  // Discover the saved device on mount. AccountApiError = signed
  // out — not an error, just "no device". Other errors silently
  // leave the toggle hidden so a flaky endpoint doesn't break the
  // catalog.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchShopClinicalInfo();
        if (!cancelled) setDevice(r.cpapDevice);
      } catch (err) {
        if (!cancelled && !(err instanceof AccountApiError)) {
          console.warn("clinical-info fetch failed", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load the compatibility map when the toggle is first
  // flipped on. Cached for the session — the catalog filter
  // doesn't change often, and a re-fetch on every toggle would
  // be wasteful.
  //
  // An AbortController is used so that rapid on/off/on toggling
  // cancels in-flight requests rather than issuing concurrent ones.
  // If the fetch fails, the toggle is reverted to off so the UI
  // doesn't show "on" while the catalog is unfiltered.
  useEffect(() => {
    if (!enabled || !device || compatPredicate) return;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const r = await fetchCompatibilityForMachine(
          { manufacturer: device.manufacturer, model: device.model ?? null },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          // Wrap in an arrow so React doesn't treat the predicate as
          // a state-updater function.
          setCompatPredicate(() => buildCompatibilityFilter(r));
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn("compatibility fetch failed", err);
          // Revert the toggle so the catalog isn't silently unfiltered.
          setEnabled(false);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [enabled, device, compatPredicate]);

  const filter = useCallback(
    <T extends { id: string }>(products: T[]): T[] => {
      if (!enabled || !compatPredicate) return products;
      return products.filter((p) => compatPredicate(p.id));
    },
    [enabled, compatPredicate],
  );

  return { device, enabled, setEnabled, loading, filter };
}
