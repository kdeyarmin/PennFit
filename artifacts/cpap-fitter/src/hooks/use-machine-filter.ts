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
  fetchCompatibilityForMachine,
  filterByCompatibility,
  type CompatibilityForMachineResponse,
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
  const [compat, setCompat] = useState<CompatibilityForMachineResponse | null>(
    null,
  );

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
  useEffect(() => {
    if (!enabled || !device || compat) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetchCompatibilityForMachine({
          manufacturer: device.manufacturer,
          model: device.model ?? null,
        });
        if (!cancelled) setCompat(r);
      } catch (err) {
        if (!cancelled) {
          console.warn("compatibility fetch failed", err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, device, compat]);

  const filter = useCallback(
    <T extends { id: string }>(products: T[]): T[] => {
      if (!enabled || !compat) return products;
      return filterByCompatibility(products, compat);
    },
    [enabled, compat],
  );

  return { device, enabled, setEnabled, loading, filter };
}
