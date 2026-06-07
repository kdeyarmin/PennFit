// Installs the demo-mode fetch interceptor.
//
// MUST run before any module captures a reference to `globalThis.fetch`
// — notably the auth client, which does `globalThis.fetch.bind(...)` at
// module-load time (lib/resupply-auth-react/src/client.ts). main.tsx
// imports this module first so the wrapper is in place before <App>
// (and its transitive auth-hooks import) is evaluated.
//
// The wrapper is a single persistent patch. It checks the demo flag at
// CALL time, so toggling demo on/off at runtime needs no re-install:
//   * demo OFF → delegate straight to the original fetch (transparent).
//   * demo ON  → route through the demo handlers; only same-origin API
//                paths are answered, everything else passes through.

import { initDemoStateFromUrl, isDemoActive } from "./state";
import { routeDemoRequest } from "./router";

let installed = false;

export function installDemoFetchInterceptor(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  installed = true;

  // Resolve `?demo=1` / stored flag before the first request fires.
  initDemoStateFromUrl();

  const originalFetch = window.fetch.bind(window);

  const demoFetch: typeof fetch = async (input, init) => {
    if (!isDemoActive()) return originalFetch(input, init);
    try {
      const handled = await routeDemoRequest(input, init);
      if (handled) return handled;
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error("[demo] handler threw:", err);
      }
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const origin = window.location?.origin ?? "http://localhost";
        const parsed = new URL(url, origin);
        const pathname = parsed.pathname;
        const isApi =
          pathname.startsWith("/api/") ||
          pathname === "/api" ||
          pathname.startsWith("/resupply-api/") ||
          pathname === "/resupply-api";
        if (isApi) {
          const method = (
            init?.method ?? (input instanceof Request ? input.method : "GET")
          ).toUpperCase();
          const body =
            method === "GET" || method === "HEAD" ? {} : { ok: true };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      } catch {
        /* ignore */
      }
    }
    return originalFetch(input, init);
  };

  window.fetch = demoFetch;
}
