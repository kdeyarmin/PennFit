import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * Stale-chunk-aware wrapper around `React.lazy`.
 *
 * Each lazy route is emitted by Vite as a content-hashed chunk
 * (e.g. `account-3f9a1c.js`). When a new release ships, those hashes
 * change and the previous build's chunk files are removed from the CDN.
 * A patient who had the site open across a deploy — or who is served a
 * stale cached `index.html` — will trigger a dynamic `import()` for a
 * chunk URL that now 404s. The promise rejects, and without recovery the
 * patient lands on the generic error-boundary screen and has to figure
 * out that a manual reload fixes it.
 *
 * This wrapper recovers automatically: the first time a recognized
 * stale-chunk load failure is seen in a tab, it forces a single full-page
 * reload (which re-fetches a fresh `index.html` pointing at the current
 * chunk hashes). A `sessionStorage` flag guards against a reload loop — if
 * the chunk still fails to load after the reload (a genuinely broken
 * deploy, an offline device, etc.), the error is rethrown and the
 * ErrorBoundary takes over as before.
 *
 * Only *recognized* dynamic-import failures trigger the reload. A real
 * runtime/syntax error thrown while evaluating a module is rethrown
 * immediately so we don't paper over an actual bug with a reload.
 */

const RELOAD_FLAG = "pf:chunk-reload";

type ModuleFactory<T> = () => Promise<{ default: T }>;

interface RetryDeps {
  /** Defaults to the real `sessionStorage` (guarded; null when unavailable). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Defaults to a real full-page reload. */
  reload?: () => void;
}

/**
 * `import()` rejections from a removed/stale chunk surface with one of a
 * handful of browser-specific messages. We match those (and the legacy
 * webpack `ChunkLoadError` name) rather than treating *every* import
 * rejection as a stale chunk, so an error thrown during module evaluation
 * isn't masked by a reload.
 */
export function isStaleChunkError(err: unknown): boolean {
  if (err instanceof Error && err.name === "ChunkLoadError") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) || // Safari
    /'?text\/html'? is not a valid JavaScript MIME type/i.test(message) // SPA fallback served HTML for a missing chunk
  );
}

function safeSessionStorage(): RetryDeps["storage"] {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Accessing sessionStorage throws in some privacy modes / sandboxed
    // iframes. Treat as unavailable and skip the loop guard.
  }
  return null;
}

/**
 * Awaits a dynamic-import factory, recovering from a stale-chunk failure
 * with a single guarded reload. Exported for unit testing; production
 * code goes through {@link lazyWithRetry}.
 */
export async function importWithRetry<T>(
  factory: ModuleFactory<T>,
  deps: RetryDeps = {},
): Promise<{ default: T }> {
  const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage;
  const reload =
    deps.reload ??
    (() => {
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    });

  try {
    const mod = await factory();
    // A clean load means whatever made the previous load fail is gone —
    // clear the guard so a future deploy in this same tab can reload again.
    storage?.removeItem(RELOAD_FLAG);
    return mod;
  } catch (err) {
    const alreadyReloaded = storage?.getItem(RELOAD_FLAG) === "1";
    if (!alreadyReloaded && isStaleChunkError(err)) {
      storage?.setItem(RELOAD_FLAG, "1");
      reload();
      // Keep the Suspense fallback up during the (imminent) navigation
      // instead of letting React resolve the rejection and flash the
      // error boundary. This promise never settles; the page reloads out
      // from under it.
      return new Promise<{ default: T }>(() => {});
    }
    throw err;
  }
}

/**
 * Drop-in replacement for `React.lazy` that adds stale-chunk reload
 * recovery. The `any` constraint mirrors React's own `lazy` signature so
 * a page component with any props shape can be wrapped; it never surfaces
 * to callers.
 */
export function lazyWithRetry<T extends ComponentType<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
  factory: ModuleFactory<T>,
): LazyExoticComponent<T> {
  return lazy(() => importWithRetry(factory));
}
