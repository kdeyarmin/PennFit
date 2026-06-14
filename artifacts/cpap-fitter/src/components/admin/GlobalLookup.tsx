// Global lookup bar — mounts in the brand header so operators can
// jump to a patient / conversation / order from any page.
//
// Auto-debounced 250ms after a 3-character minimum. Results appear
// in a dropdown directly under the input. Fully keyboard-driven: this
// is the single most-used admin control, so it implements the
// combobox/listbox ARIA contract — Arrow Up/Down move the active
// option, Enter opens it, Escape closes the dropdown — with
// `aria-activedescendant` + `aria-selected` so screen readers track
// the highlight. Clicking a hit still works.
//
// Because it's the most-used control, it's also reachable from anywhere
// without the mouse: ⌘K / Ctrl+K focuses it from any admin page, and a
// bare `/` does too unless you're already typing in a field. A small
// keycap hint advertises the shortcut while the box is empty/unfocused.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

import { humanizeStatus } from "@/components/admin/Badge";

// Platform-appropriate label for the focus shortcut. Macs show the ⌘
// glyph; everything else shows "Ctrl". Guarded for SSR/test environments
// where `navigator` may be undefined or report an empty platform.
const SHORTCUT_LABEL =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "")
    ? "⌘K"
    : "Ctrl K";

// True when a keystroke is landing in an editable surface, so a bare `/`
// can be typed normally there instead of stealing focus to the lookup.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

interface Hit {
  kind: string;
  id: string;
  label: string;
  href: string;
  hint?: string | null;
}

const KIND_TONE: Record<string, string> = {
  patient: "bg-blue-100 text-blue-900",
  conversation: "bg-violet-100 text-violet-900",
  episode: "bg-amber-100 text-amber-900",
  fulfillment: "bg-emerald-100 text-emerald-900",
  shop_order: "bg-emerald-100 text-emerald-900",
  shop_customer: "bg-slate-100 text-slate-700",
};

const LISTBOX_ID = "global-lookup-listbox";
const optionId = (i: number) => `global-lookup-option-${i}`;

export function GlobalLookup() {
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Index of the keyboard-highlighted option, or -1 when none is active
  // (e.g. before the first ArrowDown). Click/hover does not change it.
  const [active, setActive] = useState(-1);
  // Tracks input focus purely to toggle the ⌘K keycap hint (we hide it
  // once the operator is in the box so it never overlaps typed text).
  const [focused, setFocused] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced fetch.
  useEffect(() => {
    if (q.trim().length < 3) {
      setHits(null);
      setActive(-1);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(
          `/resupply-api/admin/lookup?q=${encodeURIComponent(q.trim())}`,
          { headers: { Accept: "application/json" } },
        );
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json()) as { hits: Hit[] };
          setHits(json.hits);
          setActive(-1);
          setOpen(true);
        } else {
          setHits([]);
        }
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q]);

  // Keep the active option scrolled into view as the highlight moves.
  useEffect(() => {
    if (active < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `#${optionId(active)}`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  // App-wide focus shortcut: ⌘K / Ctrl+K from anywhere, or a bare `/`
  // when the operator isn't already typing in a field. Focuses and
  // selects the input so a fresh query overwrites whatever was there.
  useEffect(() => {
    function onGlobalKey(e: KeyboardEvent) {
      const isCmdK =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === "k" || e.key === "K");
      const isSlash =
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target);
      if (!isCmdK && !isSlash) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    document.addEventListener("keydown", onGlobalKey);
    return () => document.removeEventListener("keydown", onGlobalKey);
  }, []);

  // Click-outside closes the dropdown.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function navigate(href: string) {
    setOpen(false);
    setQ("");
    setHits(null);
    setActive(-1);
    setLocation(href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const list = hits ?? [];
    if (e.key === "ArrowDown") {
      if (list.length === 0) return;
      e.preventDefault();
      setOpen(true);
      // From "no selection" land on the first item; otherwise advance,
      // clamping at the last (no wrap — predictable for a short list).
      setActive((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      if (list.length === 0) return;
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && active < list.length) {
        e.preventDefault();
        navigate(list[active]!.href);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  }

  return (
    <div ref={wrapRef} className="relative w-72" data-testid="global-lookup">
      <input
        ref={inputRef}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true);
          if (hits && hits.length > 0) setOpen(true);
        }}
        onBlur={() => setFocused(false)}
        placeholder="Lookup phone / email / id…"
        className="w-full rounded-md border py-1.5 pl-3 pr-14 text-sm"
        style={{
          borderColor: "hsl(var(--penn-gold))",
          backgroundColor: "hsl(var(--surface-2))",
        }}
        aria-label="Global lookup"
        aria-keyshortcuts="Meta+K Control+K"
        role="combobox"
        aria-expanded={open && hits !== null}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={
          open && active >= 0 ? optionId(active) : undefined
        }
      />
      {!focused && q.length === 0 && (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none text-slate-500"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-1))",
          }}
        >
          {SHORTCUT_LABEL}
        </kbd>
      )}
      {open && hits !== null && (
        <div
          className="absolute right-0 mt-1 w-full max-w-md rounded-md border bg-white shadow-lg z-50"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {busy && hits.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">
              No matches for &ldquo;{q}&rdquo;.
            </div>
          ) : (
            <ul ref={listRef} id={LISTBOX_ID} role="listbox">
              {hits.map((h, i) => (
                <li key={`${h.kind}-${h.id}`}>
                  <button
                    type="button"
                    id={optionId(i)}
                    onClick={() => navigate(h.href)}
                    onMouseEnter={() => setActive(i)}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                      i === active ? "bg-slate-100" : "hover:bg-slate-50"
                    }`}
                    role="option"
                    aria-selected={i === active}
                    // Each option is reachable via the input's
                    // aria-activedescendant, so keep them out of the tab
                    // sequence (the input is the single tab stop).
                    tabIndex={-1}
                  >
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
                        KIND_TONE[h.kind] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {humanizeStatus(h.kind)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-slate-900 font-medium truncate">
                        {h.label}
                      </span>
                      {h.hint && (
                        <span className="block text-[11px] text-slate-500 truncate">
                          {h.hint}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
