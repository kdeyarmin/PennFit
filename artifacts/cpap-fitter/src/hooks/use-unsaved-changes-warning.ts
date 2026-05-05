// useUnsavedChangesWarning — register a `beforeunload` listener so
// closing the tab / navigating away surfaces the browser's native
// "Reload site? Changes that you made may not be saved." dialog
// when `dirty` is true. Cleared automatically when `dirty` flips
// false (e.g. after a successful save) or on unmount.
//
// Why a custom hook instead of a one-line useEffect at every call
// site: the listener registration + the `returnValue` quirk are
// easy to get wrong (older Firefox required `returnValue` to be
// the empty string, modern browsers ignore the message text and
// only care that `preventDefault()` was called or `returnValue`
// was assigned). Centralising it means each consumer just passes
// a boolean and forgets the rest.
//
// Note: the hook only protects against a full page navigation,
// not in-app SPA route changes. Wouter swaps routes via
// pushState — `beforeunload` does NOT fire for those. Catching
// SPA navigation cleanly would need a wouter-aware route block,
// which is a larger lift; the page-close case is the most common
// data-loss scenario for an inline-edit form like /account.

import { useEffect } from "react";

export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      // Modern browsers ignore the string but the assignment is
      // what triggers the prompt. preventDefault is the spec-ier
      // way; we do both for max compatibility.
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
