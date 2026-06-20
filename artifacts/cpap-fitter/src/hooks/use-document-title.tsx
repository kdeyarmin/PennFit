import { useEffect } from "react";

import { useCompanyContact } from "@/lib/contact";

// Helper — find an existing meta tag by name OR property, or create
// it. We return both the element and whether we just created it so
// the cleanup path can remove tags we added (not ones already in the
// document from index.html).
function getOrCreateMeta(
  selector: string,
  attrs: Record<string, string>,
): { el: HTMLMetaElement; created: boolean } {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  let created = false;
  if (!el) {
    el = document.createElement("meta");
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.head.appendChild(el);
    created = true;
  }
  return { el, created };
}

/**
 * Pass an empty string for `pageTitle` to use the site's default title
 * from `index.html` (e.g. on the landing page where no page-specific
 * suffix is needed); the canonical update still happens.
 *
 * Why a hook instead of react-helmet-async: avoiding a 3rd-party
 * helmet provider removes a runtime dependency and one more thing to
 * keep in sync with our tightened CSP.
 */
type SchemaType = "Article" | "MedicalWebPage";

type DocumentTitleOptions = {
  /**
   * If set, the hook injects a JSON-LD `<script type="application/ld+json">`
   * for the current page so search engines render rich snippets. The hook
   * removes the script on unmount. Most long-form learn articles should
   * use "MedicalWebPage"; marketing-style brand pages benefit from
   * "Article".
   */
  schema?: SchemaType;
};

/**
 * Sets the browser tab title, meta description, canonical URL, Open
 * Graph + Twitter Card meta tags, and (optionally) a JSON-LD schema
 * `<script>` for the current page. All values are restored on unmount.
 */
export function useDocumentTitle(
  pageTitle: string,
  description?: string,
  options?: DocumentTitleOptions,
) {
  // Brand the tab-title suffix to the resolving tenant (the storefront brand
  // name, "CareMetric Breathe" as the platform default) instead of hardcoding
  // the seed tenant. The live value arrives with /api/company-info.
  const company = useCompanyContact();
  const siteTitleSuffix = ` — ${company.name}`;
  const publisherName = company.legalName || company.name;

  useEffect(() => {
    const previousTitle = document.title;
    const metaDesc = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const previousDesc = metaDesc?.getAttribute("content") ?? null;

    const fullTitle = pageTitle
      ? `${pageTitle}${siteTitleSuffix}`
      : previousTitle;
    document.title = fullTitle;
    if (description && metaDesc) {
      metaDesc.setAttribute("content", description);
    }

    /*
     * Per-page canonical. Multi-tenant: each tenant is served at its OWN
     * apex in production, so we canonicalize to the LIVE origin rather than a
     * hardcoded host — a non-Penn tenant must never canonicalize to
     * pennpaps.com. We strip the artifact basePath (e.g. "/cpap-fitter" in
     * subpath previews) and query strings / trailing slashes so the
     * canonical's value doesn't fragment across tracking-tagged inbound links.
     */
    const canonicalOrigin = window.location.origin;
    const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
    const rawPath = window.location.pathname;
    const trimmedPath =
      basePath && rawPath.startsWith(basePath)
        ? rawPath.slice(basePath.length) || "/"
        : rawPath;
    const canonicalPath =
      trimmedPath.length > 1 ? trimmedPath.replace(/\/+$/, "") : "/";
    const canonicalHref = `${canonicalOrigin}${canonicalPath}`;

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

    // Open Graph + Twitter Card meta tags. These power the share-link
    // previews on Slack, Messages, Twitter/X, Facebook, LinkedIn, etc.
    // We write the four high-impact ones — og:title, og:description,
    // og:url, twitter:title — on every route. The image fallback comes
    // from the static og:image already in index.html and isn't
    // overridden here. Track which tags we set so we can restore the
    // prior values (or remove the tags entirely) on unmount.
    const metaUpdates: Array<{
      el: HTMLMetaElement;
      attr: string;
      previous: string | null;
      created: boolean;
    }> = [];
    function setMeta(
      selector: string,
      attrs: Record<string, string>,
      contentAttr: string,
      contentValue: string,
    ) {
      const { el, created } = getOrCreateMeta(selector, attrs);
      const previous = created ? null : el.getAttribute(contentAttr);
      el.setAttribute(contentAttr, contentValue);
      metaUpdates.push({ el, attr: contentAttr, previous, created });
    }

    if (pageTitle) {
      setMeta(
        'meta[property="og:title"]',
        { property: "og:title" },
        "content",
        fullTitle,
      );
      setMeta(
        'meta[name="twitter:title"]',
        { name: "twitter:title" },
        "content",
        fullTitle,
      );
    }
    setMeta(
      'meta[property="og:url"]',
      { property: "og:url" },
      "content",
      canonicalHref,
    );
    setMeta(
      'meta[property="og:type"]',
      { property: "og:type" },
      "content",
      "website",
    );
    if (description) {
      setMeta(
        'meta[property="og:description"]',
        { property: "og:description" },
        "content",
        description,
      );
      setMeta(
        'meta[name="twitter:description"]',
        { name: "twitter:description" },
        "content",
        description,
      );
    }

    // JSON-LD schema injection — opt-in via `options.schema`. We give
    // the script a stable id (`pf-page-schema`) and remove it on
    // unmount so route changes between schema-using and non-schema
    // pages don't leave a stale script in the head.
    let schemaScript: HTMLScriptElement | null = null;
    if (options?.schema && pageTitle && description) {
      const schemaPayload = {
        "@context": "https://schema.org",
        "@type": options.schema,
        headline: pageTitle,
        name: pageTitle,
        description,
        url: canonicalHref,
        publisher: {
          "@type": "Organization",
          name: publisherName,
          url: canonicalOrigin,
        },
        ...(options.schema === "MedicalWebPage"
          ? {
              about: {
                "@type": "MedicalCondition",
                name: "Sleep apnea",
              },
            }
          : {}),
      };
      const existing = document.head.querySelector<HTMLScriptElement>(
        'script[type="application/ld+json"]#pf-page-schema',
      );
      if (existing) existing.remove();
      schemaScript = document.createElement("script");
      schemaScript.type = "application/ld+json";
      schemaScript.id = "pf-page-schema";
      schemaScript.textContent = JSON.stringify(schemaPayload);
      document.head.appendChild(schemaScript);
    }

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
      // Restore prior OG / Twitter tags. Remove the ones we created;
      // restore content on the ones that already existed.
      for (const { el, attr, previous, created } of metaUpdates) {
        if (created) {
          el.remove();
        } else if (previous !== null) {
          el.setAttribute(attr, previous);
        }
      }
      // Remove our JSON-LD schema script if we added one. We don't
      // try to restore a prior one because the SPA shell doesn't ship
      // a route-specific schema by default.
      if (schemaScript && schemaScript.parentNode) {
        schemaScript.parentNode.removeChild(schemaScript);
      }
    };
  }, [pageTitle, description, options?.schema, siteTitleSuffix, publisherName]);
}
