/**
 * Tiny `document.title` setter that reverts to the previous title on
 * unmount. The dashboard previously did not have a hook for this
 * (the OpenAPI-driven pages set titles inline) but the four ported
 * PennPaps storefront-admin pages all use it, so we provide it here
 * with the same signature as the cpap-fitter version they came
 * from.
 *
 * Pass an empty string to skip the title change (the cpap-fitter
 * convention for landing pages that prefer the static `index.html`
 * title).
 */

import { useEffect } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
