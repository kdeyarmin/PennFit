// useSearchShortcut — registers a document-level keydown listener
// so pressing "/" anywhere on the page jumps focus into a target
// search input (matching the convention used by Slack, GitHub,
// Discord, et al.). The shortcut is suppressed when the user is
// already typing in another input/textarea/contenteditable so it
// can't hijack normal text entry.
//
// Two ways to wire it up:
//
//   * pass `ref` — direct ref to the <input> (used by FAQ where the
//     search input is rendered in the same component as the hook),
//   * pass `selector` — CSS selector resolved against `document` at
//     keypress time (used by /shop where the search input lives in
//     a child component and a ref isn't readily available).
//
// `disabled` lets a parent gate the binding (e.g. when an in-page
// modal is open and capturing keys).

import { useEffect, useRef, type RefObject } from "react";

interface Options {
  ref?: RefObject<HTMLInputElement | null>;
  selector?: string;
  disabled?: boolean;
  /**
   * Optional Esc-to-clear handler. When supplied, pressing Escape
   * **while focus is in the search input** clears the query and
   * blurs the input. Pressing Escape elsewhere on the page is left
   * alone (other elements own that key — modals, popovers, etc.).
   * Caller passes the same setter that drives the input's value.
   */
  onClear?: () => void;
}

export function useSearchShortcut({
  ref,
  selector,
  disabled,
  onClear,
}: Options): void {
  // Store onClear in a ref so we can always call the latest version
  // without needing to re-register the document listener. Call sites
  // typically pass inline lambdas, so without this the listener would
  // be removed and re-added on every render that updates the query.
  const onClearRef = useRef(onClear);
  useEffect(() => {
    onClearRef.current = onClear;
  });

  useEffect(() => {
    if (disabled) return;
    function resolveInput(): HTMLInputElement | null {
      return (
        ref?.current ??
        (selector
          ? (document.querySelector(selector) as HTMLInputElement | null)
          : null)
      );
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const input = resolveInput();

      if (e.key === "Escape" && onClearRef.current && input && t === input) {
        // Only fire when the input itself is focused — Escape
        // anywhere else on the page belongs to dialogs / popovers.
        e.preventDefault();
        onClearRef.current();
        input.blur();
        return;
      }

      if (e.key !== "/") return;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref, selector, disabled]); // onClear intentionally omitted — read via ref
}
