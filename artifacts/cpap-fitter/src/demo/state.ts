// Demo-mode runtime state. Deliberately framework-free (no React) so
// the fetch interceptor — installed in main.tsx BEFORE the React tree
// or any module that binds `globalThis.fetch` — can read the flag.
//
// Demo mode is a CLIENT-ONLY sandbox: when it's on, the fetch
// interceptor (see ./install.ts) answers every same-origin API call
// from in-browser fixtures instead of the real backend. Nothing is
// persisted server-side and no real PHI is ever involved.
//
// The flag is resolved from, in priority order:
//   1. the `?demo=1` / `?demo=0` URL param (a shareable deep link),
//   2. the `pennfit:demo-mode:v1` localStorage entry.

const STORAGE_KEY = "pennfit:demo-mode:v1";
const URL_PARAM = "demo";

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();

// Cached so the hot path (every intercepted fetch) doesn't touch
// localStorage on each call. `null` means "not yet resolved".
let cached: boolean | null = null;

function readStorage(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private-mode Safari / storage disabled — default to live.
    return false;
  }
}

function writeStorage(active: boolean): void {
  try {
    if (active) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the initial demo flag from the URL param (which wins over
 * stored state) and persist it, then scrub the param so it doesn't
 * keep re-forcing the mode on every in-app navigation. Call once at
 * boot, before any code reads {@link isDemoActive}.
 */
export function initDemoStateFromUrl(): void {
  if (typeof window === "undefined") {
    cached = false;
    return;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has(URL_PARAM)) {
      const raw = params.get(URL_PARAM);
      // `?demo`, `?demo=1`, `?demo=true`, `?demo=on` → enable.
      const on =
        raw === null ||
        raw === "" ||
        raw === "1" ||
        raw === "true" ||
        raw === "on";
      writeStorage(on);
      cached = on;
      params.delete(URL_PARAM);
      const qs = params.toString();
      const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", next);
      return;
    }
  } catch {
    /* fall through to storage */
  }
  cached = readStorage();
}

/** Whether the client-side demo sandbox is currently active. */
export function isDemoActive(): boolean {
  if (cached === null) {
    cached = typeof window !== "undefined" ? readStorage() : false;
  }
  return cached;
}

/**
 * Flip demo mode on or off. Persists the choice and notifies
 * subscribers. Callers that want the app to re-fetch from the new
 * data source typically follow this with a full page reload (see
 * {@link reloadIntoMode}) — React Query caches and the in-memory
 * demo store both reset cleanly on reload.
 */
export function setDemoActive(active: boolean): void {
  if (cached === active) return;
  cached = active;
  writeStorage(active);
  for (const listener of listeners) {
    try {
      listener(active);
    } catch {
      /* a broken subscriber must not wedge the others */
    }
  }
}

/** Subscribe to demo on/off transitions. Returns an unsubscribe fn. */
export function subscribeDemo(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Persist the new mode and hard-reload the current page so every data
 * consumer (React Query caches, the in-memory demo store, the auth
 * session probe) re-resolves against the chosen source. Reloading the
 * *current* URL means "see this same page, now in the other mode".
 */
export function reloadIntoMode(active: boolean): void {
  setDemoActive(active);
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

/** Test-only: reset the module cache so each test starts clean. */
export function __resetDemoStateForTests(): void {
  cached = null;
  listeners.clear();
}
