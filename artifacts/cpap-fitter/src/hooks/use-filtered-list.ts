// useFilteredList — shared state primitive for admin list pages.
//
// Why this exists
// ---------------
// Every admin list page in src/pages/admin/* (patients, conversations,
// shop returns, shop customers, fitter leads, episodes, …) re-implements
// the same boilerplate:
//
//   const [filterA, setFilterA] = useState("");
//   const [filterB, setFilterB] = useState("");
//   const [offset, setOffset] = useState(0);
//   useEffect(() => { setOffset(0); }, [filterA, filterB]);
//
// That's three to five state hooks plus a reset-effect per page,
// repeated across ~28 admin pages. Forgetting the offset-reset is a
// common bug — the admin changes status to "paused", the list refetches
// at offset=50, and the visible page is empty because there are only
// 12 paused patients. This hook owns the entire pattern in one place
// so it's impossible to forget.
//
// Scope
// -----
// State only. The page still owns:
//   - the useMemo that builds the params object for the query hook,
//   - the actual useListX() call,
//   - the row render and the columns.
//
// That keeps the abstraction small and lets each page diverge where
// the data shape genuinely differs without fighting the hook.

import { useCallback, useRef, useState } from "react";

export interface UseFilteredListOptions {
  /** Initial offset. Default 0. */
  initialOffset?: number;
  /**
   * Page size — returned as-is so callers can pass it straight into
   * their query `limit` param without re-declaring the constant.
   * Default 25 (matches the existing PAGE_SIZE in every admin page).
   */
  pageSize?: number;
}

export interface UseFilteredListResult<F extends Record<string, unknown>> {
  /** Current filter values. */
  filters: F;
  /**
   * Update a single filter and reset offset to 0 in the same render
   * commit. Reset happens unconditionally — setting a filter to its
   * existing value still resets offset, mirroring the legacy
   * useEffect-based reset (which fires on identity change of the
   * dependency array, not value change).
   */
  setFilter: <K extends keyof F>(key: K, value: F[K]) => void;
  /** Replace the whole filter object and reset offset to 0. */
  setFilters: (next: F | ((prev: F) => F)) => void;
  /**
   * Reset all filters to the initial defaults the hook was created
   * with, and reset offset to 0. The defaults are captured on first
   * render; passing different defaults on re-render does NOT change
   * what clearFilters() restores.
   */
  clearFilters: () => void;
  /** Current pagination offset. */
  offset: number;
  /** Set the offset directly (typically wired to <Pagination onChange>). */
  setOffset: (n: number) => void;
  /** Page size from options (default 25). */
  pageSize: number;
}

export function useFilteredList<F extends Record<string, unknown>>(
  initialFilters: F,
  opts: UseFilteredListOptions = {},
): UseFilteredListResult<F> {
  const initialOffset = opts.initialOffset ?? 0;
  const pageSize = opts.pageSize ?? 25;
  // Capture initial filters once. The first-render value is what
  // clearFilters() restores to; passing a fresh literal on re-render
  // would otherwise change the reset target between renders.
  const initialFiltersRef = useRef(initialFilters);
  const [filters, setFiltersState] = useState<F>(initialFilters);
  const [offset, setOffset] = useState<number>(initialOffset);

  const setFilter = useCallback(
    <K extends keyof F>(key: K, value: F[K]): void => {
      setFiltersState((prev) => ({ ...prev, [key]: value }));
      setOffset(0);
    },
    [],
  );

  const setFilters = useCallback((next: F | ((prev: F) => F)): void => {
    setFiltersState((prev) =>
      typeof next === "function" ? (next as (p: F) => F)(prev) : next,
    );
    setOffset(0);
  }, []);

  const clearFilters = useCallback((): void => {
    setFiltersState(initialFiltersRef.current);
    setOffset(0);
  }, []);

  return {
    filters,
    setFilter,
    setFilters,
    clearFilters,
    offset,
    setOffset,
    pageSize,
  };
}
