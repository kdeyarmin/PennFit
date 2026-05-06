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

export const PENNBOT_OPEN_EVENT = "pennbot:open";

export interface PennBotOpenDetail {
  /** Pre-fill the input with this text. */
  prefill?: string;
  /** When true, send the prefill immediately instead of waiting. */
  autoSend?: boolean;
  /** Open on the contact tab instead of the chat tab. */
  contactTab?: boolean;
}

export function openPennBot(detail: PennBotOpenDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PENNBOT_OPEN_EVENT, { detail }));
}
