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
// 7-day TTL: long enough to cover "I started a draft Friday and came
// back Monday" while short enough that a draft from a previous quarter
// — typed by an admin who might no longer be on the team — quietly
// expires instead of resurrecting on rehydrate. The value is rewritten
// on every change so an actively-edited draft never expires.
const DEFAULT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft {
  value: string;
  /** ISO 8601 timestamp of the last write. */
  savedAt: string;
}

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    // localStorage can throw in private-browsing modes or when
    // quota is exceeded. Treat as "no draft available" — autosave
    // is an opportunistic feature, not a correctness guarantee.
    return null;
  }
}

function readDraft(
  key: string,
  ttlMs: number,
): { value: string; savedAt: Date | null } {
  const raw = readRaw(key);
  if (raw == null || raw.length === 0) return { value: "", savedAt: null };
  // Backwards-compat: earlier versions stored the raw string. Treat
  // those as "no metadata, but still a draft" — surface the value but
  // re-write to the JSON shape on the next save so the next read has
  // a savedAt.
  if (raw.length === 0 || raw[0] !== "{") {
    return { value: raw, savedAt: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof parsed.value !== "string") return { value: "", savedAt: null };
    if (typeof parsed.savedAt !== "string") {
      return { value: parsed.value, savedAt: null };
    }
    const savedAt = new Date(parsed.savedAt);
    if (Number.isNaN(savedAt.getTime())) {
      return { value: parsed.value, savedAt: null };
    }
    if (Date.now() - savedAt.getTime() > ttlMs) {
      // Expired — drop it on read so a stale draft never resurfaces
      // weeks after the conversation it belonged to.
      try {
        window.localStorage.removeItem(STORAGE_PREFIX + key);
      } catch {
        /* ignore */
      }
      return { value: "", savedAt: null };
    }
    return { value: parsed.value, savedAt };
  } catch {
    // JSON-parse failure on what looked like JSON — treat as no draft
    // and clean up the corrupted entry.
    try {
      window.localStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      /* ignore */
    }
    return { value: "", savedAt: null };
  }
}

function writeDraft(key: string, value: string): Date | null {
  if (typeof window === "undefined") return null;
  try {
    if (value.length === 0) {
      window.localStorage.removeItem(STORAGE_PREFIX + key);
      return null;
    }
    const savedAt = new Date();
    const stored: StoredDraft = {
      value,
      savedAt: savedAt.toISOString(),
    };
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(stored));
    return savedAt;
  } catch {
    // Same as readDraft — ignore storage failures.
    return null;
  }
}

export interface DraftAutosave {
  /** True if a non-empty draft was found at mount and restored. */
  restored: boolean;
  /**
   * Timestamp of the most recent autosave. `null` until the first
   * write completes (or when localStorage is unavailable). Useful
   * for rendering a "saved 5 minutes ago" hint without forcing the
   * caller to track its own timer.
   */
  savedAt: Date | null;
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
  options?: { ttlMs?: number },
): DraftAutosave {
  const ttlMs = options?.ttlMs ?? DEFAULT_DRAFT_TTL_MS;
  const [restored, setRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
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
    const existing = readDraft(key, ttlMs);
    hasHydratedRef.current = true;
    if (existing.value.length > 0) {
      applyRef.current(existing.value);
      setRestored(true);
      setSavedAt(existing.savedAt);
    } else {
      setRestored(false);
      setSavedAt(null);
    }
  }, [key, ttlMs]);

  // Debounced write on value change. Skip the very first effect
  // run (it would write the empty initial value over a real
  // localStorage entry before the hydration effect lands).
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    const t = window.setTimeout(() => {
      const at = writeDraft(key, value);
      setSavedAt(at);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [key, value]);

  return {
    restored,
    savedAt,
    clear: () => {
      writeDraft(key, "");
      setRestored(false);
      setSavedAt(null);
    },
  };
}
