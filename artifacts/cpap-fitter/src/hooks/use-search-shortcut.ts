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

import { useEffect, type RefObject } from "react";

interface Options {
  ref?: RefObject<HTMLInputElement | null>;
  selector?: string;
  disabled?: boolean;
}

export function useSearchShortcut({ ref, selector, disabled }: Options): void {
  useEffect(() => {
    if (disabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      const input =
        ref?.current ??
        (selector
          ? (document.querySelector(selector) as HTMLInputElement | null)
          : null);
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref, selector, disabled]);
}
