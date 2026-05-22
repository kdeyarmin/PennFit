// Persist a string-enum component state in a URL search param.
//
// Usage:
//
//   type Tab = "open" | "approved" | "rejected" | "all";
//   const ALLOWED = new Set<Tab>(["open", "approved", "rejected", "all"]);
//
//   const [tab, setTab] = useUrlState<Tab>({
//     key: "tab",
//     defaultValue: "open",
//     isAllowed: (v): v is Tab => ALLOWED.has(v as Tab),
//   });
//
// Semantics:
//
//   * Initial render reads the param from `window.location.search`.
//     Values that fail `isAllowed` (or any value when `window` is
//     undefined — SSR) fall back to `defaultValue`.
//   * `setTab(next)` updates state AND the URL via `history.replaceState`.
//     We pick `replaceState` rather than `pushState` so each tab click
//     doesn't fill the back-history; the admin can still get back to
//     wherever they came from with a single Back press.
//   * When `next === defaultValue` the param is removed from the URL
//     so the canonical landing URL stays clean.
//   * A `popstate` listener rehydrates state so the browser back/forward
//     buttons re-select the right value.
//
// All callers should keep the `isAllowed` predicate narrow — anything
// not in the allow-list is silently coerced to `defaultValue`, so the
// page can't be put into an unrecognised state via a hand-edited URL.

import { useEffect, useState } from "react";

export interface UseUrlStateOptions<T extends string> {
  key: string;
  defaultValue: T;
  isAllowed: (value: string) => value is T;
}

export function useUrlState<T extends string>(
  opts: UseUrlStateOptions<T>,
): [T, (next: T) => void] {
  const { key, defaultValue, isAllowed } = opts;
  const read = (): T => {
    if (typeof window === "undefined") return defaultValue;
    const raw = new URLSearchParams(window.location.search).get(key);
    return raw && isAllowed(raw) ? raw : defaultValue;
  };
  const [value, setValueState] = useState<T>(read);
  const setValue = (next: T): void => {
    setValueState(next);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (next === defaultValue) params.delete(key);
    else params.set(key, next);
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(window.history.state, "", newUrl);
  };
  useEffect(() => {
    const handler = (): void => setValueState(read());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
    // `read` closes over `key`/`defaultValue`/`isAllowed`; callers that
    // need to change those after mount are not a supported case (the
    // param key isn't expected to vary across the lifetime of a page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [value, setValue];
}
