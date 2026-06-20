import { useEffect } from "react";

import { isPlatformApexHost } from "@/lib/platform-host";

/**
 * Marks the current page `noindex` while it is mounted — EXCEPT on the
 * platform's public production apex (`cmbreathe.com`), which is the canonical,
 * indexable home of the Breathe marketing site.
 *
 * Everywhere else stays noindex: tenant storefront domains (e.g.
 * `pennpaps.com`), local dev, and the Railway `*.up.railway.app` deploy/preview
 * hosts (staging / duplicate content). The tag is removed on unmount so it
 * never leaks onto a tenant's own pages during SPA navigation.
 *
 * Shared by every Breathe marketing page that mounts its own shell
 * (`breathe.tsx`'s `BreatheShell`, plus the standalone `breathe-features` and
 * `breathe-faq` pages) so the apex-indexing rule stays in exactly one place.
 */
export function useNoIndexExceptApex(): void {
  useEffect(() => {
    // The apex is the one host we WANT indexed — skip the tag there.
    if (isPlatformApexHost()) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, follow";
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}
