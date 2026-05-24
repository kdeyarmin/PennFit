// useBulkSelection — selection state for admin list pages.
//
// Extracted from src/pages/admin/patients.tsx, where it was the only
// page implementing select-many + bulk-action UX. Generalising it
// here unblocks rolling the same pattern out to conversations,
// shop-returns, fitter-leads, etc., without rebuilding the
// indeterminate-checkbox + auto-prune logic from scratch each time.
//
// Selection lifecycle
// -------------------
// Selection is intentionally page-scoped: ids that scroll out of
// view (paginate, filter change, refetch dropping a row) are pruned
// from the selection so the action bar's "N selected" count always
// reflects what the admin can actually see. The alternative —
// preserving selection across pages — would have an admin clicking
// "Pause 12" and accidentally pausing 12 patients on a page they
// scrolled past five minutes ago.
//
// Pure logic
// ----------
// The five state transitions are exported as standalone functions so
// they can be exhaustively tested in the node vitest environment
// (the rest of this codebase tests hooks via source-analysis + pure
// helpers — see hooks/use-url-state.test.ts).

import { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests).
// ---------------------------------------------------------------------------

/**
 * Build the next selection after toggling one id. Adds if absent,
 * removes if present. Always returns a fresh Set so consumers see
 * a new identity.
 */
export function computeToggledOne(
  prev: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Build the next selection after the "toggle all visible" action.
 *   - If every visible id is already selected, removes them all.
 *   - Otherwise, adds every visible id.
 * Ids selected on prior pages (that aren't in visibleIds) are
 * preserved in both branches.
 */
export function computeToggledAllVisible(
  prev: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const next = new Set(prev);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
  if (allOn) {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

/**
 * Drop ids that are no longer visible. Returns the same Set
 * identity when nothing changed, so a useState setter passed this
 * helper short-circuits the re-render.
 */
export function pruneToVisible(
  prev: ReadonlySet<string>,
  visibleIds: readonly string[],
): ReadonlySet<string> {
  if (prev.size === 0) return prev;
  const visible = new Set(visibleIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of prev) {
    if (visible.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : prev;
}

export function computeAllVisibleSelected(
  visibleIds: readonly string[],
  selected: ReadonlySet<string>,
): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
}

export function computeSomeVisibleSelected(
  visibleIds: readonly string[],
  selected: ReadonlySet<string>,
): boolean {
  return visibleIds.some((id) => selected.has(id));
}

// ---------------------------------------------------------------------------
// React hook.
// ---------------------------------------------------------------------------

export interface UseBulkSelectionOptions<T> {
  /** Items rendered on the current page. */
  visibleItems: readonly T[];
  /** Stable id extractor for an item. */
  itemId: (item: T) => string;
}

export interface UseBulkSelectionResult {
  /** Set of currently selected ids (across the visible page). */
  selectedIds: ReadonlySet<string>;
  /** True iff every visible row is selected (non-empty). */
  allVisibleSelected: boolean;
  /** True iff at least one visible row is selected. Used for the header indeterminate state. */
  someVisibleSelected: boolean;
  /** Toggle a single row by id. */
  toggleOne: (id: string) => void;
  /**
   * Toggle all visible rows. If any visible row is unselected, this
   * selects every visible row; if all visible rows are already
   * selected, this clears the visible selection.
   */
  toggleAllVisible: () => void;
  /** Clear the entire selection (visible + any preserved off-page ids). */
  clear: () => void;
  /**
   * Replace the selection with a fixed set. Used by partial-failure
   * paths (e.g., bulk-pause returns 10 ok + 2 failed; re-select the
   * 2 failed ids so the admin can retry just those).
   */
  set: (ids: ReadonlySet<string>) => void;
}

export function useBulkSelection<T>(
  opts: UseBulkSelectionOptions<T>,
): UseBulkSelectionResult {
  const { visibleItems, itemId } = opts;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Recompute the visible-ids list once per render so the prune
  // effect and the derived booleans agree on the same snapshot.
  const visibleIds = useMemo(
    () => visibleItems.map(itemId),
    [visibleItems, itemId],
  );

  // Prune off-screen ids on every visible-set change. Uses pure
  // pruneToVisible which returns the same Set identity on no-op
  // so React's bail-out skips the re-render in the steady state.
  useEffect(() => {
    setSelectedIds((prev) => pruneToVisible(prev, visibleIds));
  }, [visibleIds]);

  const allVisibleSelected = computeAllVisibleSelected(visibleIds, selectedIds);
  const someVisibleSelected = computeSomeVisibleSelected(
    visibleIds,
    selectedIds,
  );

  const toggleOne = useCallback((id: string): void => {
    setSelectedIds((prev) => computeToggledOne(prev, id));
  }, []);

  const toggleAllVisible = useCallback((): void => {
    setSelectedIds((prev) => computeToggledAllVisible(prev, visibleIds));
  }, [visibleIds]);

  const clear = useCallback((): void => {
    setSelectedIds(new Set());
  }, []);

  const set = useCallback((ids: ReadonlySet<string>): void => {
    setSelectedIds(new Set(ids));
  }, []);

  return {
    selectedIds,
    allVisibleSelected,
    someVisibleSelected,
    toggleOne,
    toggleAllVisible,
    clear,
    set,
  };
}
