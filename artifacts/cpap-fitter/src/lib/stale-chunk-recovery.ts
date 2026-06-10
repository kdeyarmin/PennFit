// Recovers from the stale-chunk failure mode that follows every deploy.
//
// The admin console lazy-loads ~70 per-route chunks (and the storefront
// several more) whose filenames are content-hashed. A deploy replaces the
// whole asset directory, so any tab opened BEFORE the deploy still holds an
// index.html that references the old hashed URLs; the first navigation to a
// route the user hasn't visited yet then 404s its dynamic import and the
// thrown error lands in the nearest ErrorBoundary as "Something went wrong".
//
// Vite surfaces exactly this failure as a cancelable `vite:preloadError`
// event on window, and the documented recovery is a full reload — the fresh
// index.html points at the new hashed chunks. A sessionStorage timestamp
// guards against a reload loop when a chunk is GENUINELY missing (not just
// stale): on a second failure inside the window we let the error propagate
// to the ErrorBoundary, which is the pre-existing behavior.

const RELOADED_AT_KEY = "pf:chunk-reload-at";
const RELOAD_LOOP_WINDOW_MS = 60_000;

// Structural subset of Window so tests can drive the handler without
// fighting jsdom's non-configurable location.reload.
export interface StaleChunkRecoveryHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
  location: { reload(): void };
}

export function installStaleChunkRecovery(
  host: StaleChunkRecoveryHost = window,
): void {
  host.addEventListener("vite:preloadError", (event) => {
    const now = Date.now();
    try {
      const last = Number(host.sessionStorage.getItem(RELOADED_AT_KEY) ?? "0");
      if (now - last < RELOAD_LOOP_WINDOW_MS) return;
      host.sessionStorage.setItem(RELOADED_AT_KEY, String(now));
    } catch {
      // Storage unavailable (sandboxed iframe / privacy mode): without a
      // way to detect a loop, an auto-reload could spin forever — fall
      // through to the ErrorBoundary instead.
      return;
    }
    // Suppress the throw; the reload IS the recovery. Without this the
    // ErrorBoundary card flashes for the instant before navigation.
    event.preventDefault();
    host.location.reload();
  });
}
