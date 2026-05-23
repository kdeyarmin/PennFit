// useDocumentMeta — declarative `<head>` injector for OpenGraph meta
// tags and JSON-LD structured-data scripts.
//
// Scope of this hook: the bits of <head> that the existing
// `useDocumentTitle` hook in this codebase deliberately doesn't
// touch. Title + description + canonical stay over there because
// every public page needs them; OG + JSON-LD only matter on the
// product detail page today, so they live in their own thin hook
// that page-level components opt into.
//
// SPA-SEO caveat:
//   This is a Vite SPA so the meta is injected client-side after
//   hydration. Modern Googlebot renders JS and will index these
//   tags. Static OG crawlers (Slack, Discord, Facebook, iMessage)
//   do NOT execute JS, so unfurls of /shop/p/:id links will fall
//   back to the document-level OG tags from index.html. Documented
//   in replit.md; pre-rendering or SSG of the product detail page
//   is a future-work item the team has explicitly accepted for v1.
//
// Lifecycle contract:
//   * On mount / re-render with new inputs we upsert tags by a
//     `data-doc-meta="<key>"` marker so re-runs replace rather than
//     duplicate.
//   * On unmount we remove every tag we created so client-side
//     navigation away from the page leaves <head> clean.

import { useEffect } from "react";

export interface OpenGraphTags {
  /** og:title */
  title: string;
  /** og:description */
  description: string;
  /** og:image — fully qualified URL to render on share unfurls. */
  image?: string;
  /** og:url — canonical URL of the current page. */
  url?: string;
  /** og:type, e.g. "product" or "website". Defaults to "website". */
  type?: string;
  /** og:site_name */
  siteName?: string;
}

/**
 * One JSON-LD payload (will be JSON.stringify'd into a single
 * <script type="application/ld+json"> tag). Pass `null` to skip
 * emitting the tag this render.
 */
export type JsonLdValue = Record<string, unknown> | null;

interface UseDocumentMetaOptions {
  openGraph?: OpenGraphTags | null;
  /** Single payload — pass an array if you ever need multiple graphs. */
  jsonLd?: JsonLdValue;
}

const META_DATA_ATTR = "data-doc-meta";

function upsertMeta(
  attr: "property" | "name",
  key: string,
  value: string,
): HTMLMetaElement {
  // Marker selector so re-renders update the same node and unmount
  // cleans up exactly the nodes we created. We don't reuse tags that
  // were already in the static index.html — those don't carry the
  // marker, so we leave them alone (and let the OG fallback work
  // for static OG scrapers).
  const selector = `meta[${META_DATA_ATTR}="${CSS.escape(key)}"]`;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    el.setAttribute(META_DATA_ATTR, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", value);
  return el;
}

function upsertJsonLd(payload: JsonLdValue): HTMLScriptElement | null {
  const selector = `script[${META_DATA_ATTR}="json-ld"]`;
  const existing = document.head.querySelector<HTMLScriptElement>(selector);
  if (!payload) {
    if (existing) existing.remove();
    return null;
  }
  if (existing) {
    existing.textContent = JSON.stringify(payload);
    return existing;
  }
  const el = document.createElement("script");
  el.setAttribute("type", "application/ld+json");
  el.setAttribute(META_DATA_ATTR, "json-ld");
  el.textContent = JSON.stringify(payload);
  document.head.appendChild(el);
  return el;
}

/**
 * Inject OpenGraph meta + an optional JSON-LD `<script>` for the
 * lifetime of the calling component. Pass `null`/`undefined` for a
 * field to leave it out (and remove any tag this hook had previously
 * inserted for it). Cleans up every tag it created on unmount.
 */
export function useDocumentMeta(opts: UseDocumentMetaOptions): void {
  const { openGraph, jsonLd } = opts;

  // Stable serialization keys — passing `openGraph` / `jsonLd` directly
  // would re-run the effect on every render even when the actual
  // values are unchanged (object identity flips on re-render).
  const ogKey = openGraph ? JSON.stringify(openGraph) : null;
  const jsonLdKey = jsonLd ? JSON.stringify(jsonLd) : null;

  useEffect(() => {
    const created: Element[] = [];

    if (openGraph) {
      created.push(
        upsertMeta("property", "og:title", openGraph.title),
        upsertMeta("property", "og:description", openGraph.description),
        upsertMeta("property", "og:type", openGraph.type ?? "website"),
      );
      if (openGraph.image) {
        created.push(upsertMeta("property", "og:image", openGraph.image));
        // Twitter card mirror — small, but visibly nicer unfurls.
        created.push(upsertMeta("name", "twitter:card", "summary_large_image"));
        created.push(upsertMeta("name", "twitter:image", openGraph.image));
      }
      if (openGraph.url) {
        created.push(upsertMeta("property", "og:url", openGraph.url));
      }
      if (openGraph.siteName) {
        created.push(
          upsertMeta("property", "og:site_name", openGraph.siteName),
        );
      }
    }

    const script = upsertJsonLd(jsonLd ?? null);
    if (script) created.push(script);

    return () => {
      // Tear down only the nodes carrying our marker so we never
      // accidentally remove the document's static OG fallbacks.
      for (const el of created) {
        if (el.getAttribute(META_DATA_ATTR)) {
          el.remove();
        }
      }
    };
    // Deps: the stringified keys (ogKey, jsonLdKey) ARE the meaningful
    // identity of the meta state — they were computed precisely to
    // make this effect cheap to re-run only when content changes.
    // Including the raw `openGraph` / `jsonLd` object refs forced a
    // re-run on every render that produced a new object literal
    // upstream (which most PDPs do), thrashing the <head> nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ogKey, jsonLdKey]);
}
