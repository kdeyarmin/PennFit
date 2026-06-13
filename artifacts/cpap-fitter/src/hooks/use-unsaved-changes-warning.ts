// useUnsavedChangesWarning — register tab-close and same-origin link
// guards so customers do not accidentally discard in-progress edits.
//
// Why a custom hook instead of a one-line useEffect at every call
// site: the listener registration + the `returnValue` quirk are
// easy to get wrong (older Firefox required `returnValue` to be
// the empty string, modern browsers ignore the message text and
// only care that `preventDefault()` was called or `returnValue`
// was assigned). Centralising it means each consumer just passes
// a boolean and forgets the rest.
//
// Note: `beforeunload` handles tab close, reload, and true page
// navigation. The click guard below covers the most common Wouter
// path: clicking a same-origin <a href>. Components that change
// in-page state without links, such as account tabs, should still
// call confirmDiscardUnsavedChanges() before unmounting dirty forms.

import { useEffect } from "react";

export const UNSAVED_CHANGES_MESSAGE =
  "You have unsaved changes. Leave without saving?";

export function confirmDiscardUnsavedChanges(
  message = UNSAVED_CHANGES_MESSAGE,
): boolean {
  if (typeof window === "undefined") return true;
  return window.confirm(message);
}

function anchorForClick(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest("a[href]");
}

function isSameOriginNavigation(
  anchor: HTMLAnchorElement,
  event: MouseEvent,
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
    return false;
  }
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;

  const current = new URL(window.location.href);
  return !(
    url.pathname === current.pathname &&
    url.search === current.search &&
    url.hash !== current.hash
  );
}

export function useUnsavedChangesWarning(
  dirty: boolean,
  message = UNSAVED_CHANGES_MESSAGE,
): void {
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

  useEffect(() => {
    if (!dirty) return;
    function onDocumentClick(e: MouseEvent) {
      const anchor = anchorForClick(e.target);
      if (!anchor || !isSameOriginNavigation(anchor, e)) return;
      if (confirmDiscardUnsavedChanges(message)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, [dirty, message]);
}
