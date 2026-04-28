// Draft autosave hook for the reply composer.
//
// Persists a textarea value to localStorage so an accidental tab
// close, browser refresh, or navigation does not lose half-typed
// admin replies. Each draft is keyed by a caller-supplied scope
// (typically `reply-draft:${conversationId}`) so drafts on
// different conversations don't trample each other.
//
// Lifecycle:
//   1. On mount: read localStorage. If non-empty, hydrate the
//      caller's state and report `restored=true` so the UI can
//      show a "Draft restored" hint.
//   2. On `value` change: debounce a localStorage write by 250ms.
//      The debounce keeps the hot keystroke loop off of the
//      synchronous storage write path.
//   3. On `clear()`: drop the localStorage entry. The composer
//      calls this on successful send.
//
// PHI note: drafts are stored in the admin's browser localStorage,
// scoped to the dashboard origin. The browser is already in scope
// of the admin's session and cannot leak this to other origins.
// Drafts are not synced back to the server so the audit log
// remains the canonical source of "what was sent".

import { useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "reply-draft:";
const DEBOUNCE_MS = 250;

function readDraft(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) ?? "";
  } catch {
    // localStorage can throw in private-browsing modes or when
    // quota is exceeded. Treat as "no draft available" — autosave
    // is an opportunistic feature, not a correctness guarantee.
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value.length === 0) {
      window.localStorage.removeItem(STORAGE_PREFIX + key);
    } else {
      window.localStorage.setItem(STORAGE_PREFIX + key, value);
    }
  } catch {
    // Same as readDraft — ignore storage failures.
  }
}

export interface DraftAutosave {
  /** True if a non-empty draft was found at mount and restored. */
  restored: boolean;
  /** Drop the saved draft (call on successful send). */
  clear: () => void;
}

/**
 * Drop every `reply-draft:*` entry from localStorage. Call this on
 * sign-out so PHI-bearing half-typed replies don't survive across
 * admin sessions on a shared workstation. Safe to call when no
 * drafts exist; safe to call when localStorage is unavailable
 * (private browsing, quota errors).
 *
 * We intentionally scan ALL keys instead of tracking active draft
 * keys: a draft can be created in one tab and never sent before
 * sign-out happens in another tab, so an in-memory registry would
 * miss those.
 */
export function clearAllDrafts(): void {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) window.localStorage.removeItem(k);
  } catch {
    // localStorage unavailable — nothing to clean up.
  }
}

/**
 * Bind a textarea state value to localStorage. Returns the
 * restored draft (if any) once at mount via the `applyRestored`
 * callback, then keeps localStorage in sync with the caller's
 * state thereafter.
 *
 * Usage:
 *   const [body, setBody] = useState("");
 *   const draft = useDraftAutosave(`reply-draft:${conversationId}`,
 *     body,
 *     (restored) => setBody(restored),
 *   );
 *   // on success: draft.clear();
 */
export function useDraftAutosave(
  key: string,
  value: string,
  applyRestored: (restored: string) => void,
): DraftAutosave {
  const [restored, setRestored] = useState(false);
  const hasHydratedRef = useRef(false);
  // Always reflect the latest applyRestored without forcing the
  // mount-effect to re-run when the caller's identity changes
  // (which would re-hydrate on every render and clobber typing).
  const applyRef = useRef(applyRestored);
  applyRef.current = applyRestored;

  // One-time hydration on mount, scoped per-key. If the caller
  // re-mounts with a different key (e.g. switching conversations),
  // re-hydrate from that key.
  useEffect(() => {
    hasHydratedRef.current = false;
    const existing = readDraft(key);
    hasHydratedRef.current = true;
    if (existing.length > 0) {
      applyRef.current(existing);
      setRestored(true);
    } else {
      setRestored(false);
    }
  }, [key]);

  // Debounced write on value change. Skip the very first effect
  // run (it would write the empty initial value over a real
  // localStorage entry before the hydration effect lands).
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    const t = window.setTimeout(() => {
      writeDraft(key, value);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [key, value]);

  return {
    restored,
    clear: () => {
      writeDraft(key, "");
      setRestored(false);
    },
  };
}
