// Tiny window-event bus for opening the PennBot launcher from anywhere
// on the site. The launcher subscribes to this event and pops itself
// open with the supplied prefill so any in-page CTA can ask the bot a
// contextual question without lifting a piece of state up to a shared
// context provider.
//
// We deliberately use a CustomEvent on `window` (not React Context or
// a state library) because the launcher lives at the Layout root and
// gets re-rendered/replaced when route chunks load lazily; a plain
// DOM event survives all of that, and the launcher only has to
// register one listener once.
//
// We also expose `openPennBot` on `window.pennpaps` so out-of-React
// callers (URL deep-link handlers, third-party scripts, e2e tests)
// can trigger it without an ESM import.

export const PENNBOT_OPEN_EVENT = "pennbot:open";

export interface PennBotOpenDetail {
  /** Pre-fill the input with this text. */
  prefill?: string;
  /** When true, send the prefill immediately instead of waiting. */
  autoSend?: boolean;
  /** Open on the contact tab instead of the chat tab. */
  contactTab?: boolean;
}

declare global {
  interface Window {
    pennpaps?: {
      openPennBot?: (detail?: PennBotOpenDetail) => void;
    };
  }
}

export function openPennBot(detail: PennBotOpenDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PENNBOT_OPEN_EVENT, { detail }));
}

if (typeof window !== "undefined") {
  window.pennpaps = window.pennpaps ?? {};
  window.pennpaps.openPennBot = openPennBot;
}

/**
 * Returns a query string value for `?ask=` if present, else null.
 * Trims whitespace and caps to MAX_USER_MESSAGE_CHARS (1500) so the
 * caller doesn't have to defend against truncated paste-bombs.
 */
export function readAskFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const askParam = params.get("ask")?.trim();
    if (askParam && askParam.length > 0) return askParam.slice(0, 1500);
    const hash = window.location.hash;
    if (hash.startsWith("#ask=")) {
      const decoded = decodeURIComponent(hash.slice(5)).trim();
      if (decoded.length > 0) return decoded.slice(0, 1500);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strip the `ask` param / hash from the URL after we've consumed it,
 * so a refresh doesn't re-fire the prefill and a shareable URL
 * doesn't accumulate state. Uses replaceState so we don't clutter
 * history.
 */
export function clearAskFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    let dirty = false;
    if (url.searchParams.has("ask")) {
      url.searchParams.delete("ask");
      dirty = true;
    }
    if (url.hash.startsWith("#ask=")) {
      url.hash = "";
      dirty = true;
    }
    if (dirty) {
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  } catch {
    // ignore — best effort
  }
}
