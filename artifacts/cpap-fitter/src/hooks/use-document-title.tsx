import { useEffect } from "react";

const SITE_TITLE_SUFFIX = " — PennPaps by Penn Home Medical Supply";

/**
 * Sets the browser tab title (and optionally the meta description) for the
 * current page. Restores the previous values when the component unmounts so
 * client-side navigation between routes always shows the right tab title and
 * social-share preview text.
 *
 * Pass an empty string for `pageTitle` to use the site's default title from
 * `index.html` (i.e. on the landing page where no page-specific suffix is
 * needed).
 *
 * Why a hook instead of react-helmet-async: every public page only needs to
 * set two tags (title + description). Avoiding a 3rd-party helmet provider
 * removes a runtime dependency and one more thing to keep in sync with our
 * tightened CSP.
 */
export function useDocumentTitle(pageTitle: string, description?: string) {
  useEffect(() => {
    const previousTitle = document.title;
    const metaDesc = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const previousDesc = metaDesc?.getAttribute("content") ?? null;

    document.title = pageTitle ? `${pageTitle}${SITE_TITLE_SUFFIX}` : previousTitle;
    if (description && metaDesc) {
      metaDesc.setAttribute("content", description);
    }

    return () => {
      document.title = previousTitle;
      if (previousDesc !== null && metaDesc) {
        metaDesc.setAttribute("content", previousDesc);
      }
    };
  }, [pageTitle, description]);
}
