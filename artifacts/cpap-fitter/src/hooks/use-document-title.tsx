import { useEffect } from "react";

const SITE_TITLE_SUFFIX = " — PennPaps by Penn Home Medical Supply";

/*
 * Production origin used to mint canonical URLs. We deliberately
 * hardcode the prod hostname (rather than read window.location.origin)
 * so preview/staging deploys — which serve the same SPA HTML on a
 * different host — point search engines at the production URL and de-
 * duplicate cleanly. The basePath segment (e.g. `/cpap-fitter`) is NOT
 * included because production serves PennPaps at the apex.
 */
const CANONICAL_ORIGIN = "https://pennpaps.com";

/**
 * Sets the browser tab title (and optionally the meta description) and
 * a route-aware canonical URL for the current page. Restores the
 * previous values when the component unmounts so client-side
 * navigation between routes always shows the right tab title, share
 * preview text, and `<link rel="canonical">`.
 *
 * Pass an empty string for `pageTitle` to use the site's default title
 * from `index.html` (e.g. on the landing page where no page-specific
 * suffix is needed); the canonical update still happens.
 *
 * Why a hook instead of react-helmet-async: every public page only
 * needs to set three tags (title + description + canonical). Avoiding
 * a 3rd-party helmet provider removes a runtime dependency and one
 * more thing to keep in sync with our tightened CSP.
 */
export function useDocumentTitle(pageTitle: string, description?: string) {
  useEffect(() => {
    const previousTitle = document.title;
    const metaDesc = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const previousDesc = metaDesc?.getAttribute("content") ?? null;

    document.title = pageTitle
      ? `${pageTitle}${SITE_TITLE_SUFFIX}`
      : previousTitle;
    if (description && metaDesc) {
      metaDesc.setAttribute("content", description);
    }

    /*
     * Per-page canonical. We strip the artifact basePath (e.g.
     * "/cpap-fitter" in subpath previews) so the canonical points at
     * the production-shaped URL. Query strings and trailing slashes
     * are stripped to avoid collapsing the canonical's value across
     * tracking-tagged inbound links.
     */
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    const rawPath = window.location.pathname;
    const trimmedPath =
      basePath && rawPath.startsWith(basePath)
        ? rawPath.slice(basePath.length) || "/"
        : rawPath;
    const canonicalPath =
      trimmedPath.length > 1 ? trimmedPath.replace(/\/+$/, "") : "/";
    const canonicalHref = `${CANONICAL_ORIGIN}${canonicalPath}`;

    let canonicalEl = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    let canonicalCreatedHere = false;
    const previousCanonicalHref = canonicalEl?.getAttribute("href") ?? null;
    if (!canonicalEl) {
      canonicalEl = document.createElement("link");
      canonicalEl.setAttribute("rel", "canonical");
      document.head.appendChild(canonicalEl);
      canonicalCreatedHere = true;
    }
    canonicalEl.setAttribute("href", canonicalHref);

    return () => {
      document.title = previousTitle;
      if (previousDesc !== null && metaDesc) {
        metaDesc.setAttribute("content", previousDesc);
      }
      // Restore prior canonical so back/forward navigation between
      // hook-using and non-hook-using pages doesn't leave a stale
      // href on the document.
      if (canonicalEl && canonicalCreatedHere) {
        canonicalEl.remove();
      } else if (canonicalEl && previousCanonicalHref !== null) {
        canonicalEl.setAttribute("href", previousCanonicalHref);
      }
    };
  }, [pageTitle, description]);
}
