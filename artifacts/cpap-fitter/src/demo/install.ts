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
      // The interceptor must never break the app. If a handler throws,
      // fall through to the real network rather than failing the call.
      console.error("[demo] handler threw, passing through:", err);
    }
    return originalFetch(input, init);
  };

  window.fetch = demoFetch;
}
