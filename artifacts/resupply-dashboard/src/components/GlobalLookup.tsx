// Global lookup bar — mounts in the brand header so operators can
// jump to a patient / conversation / order from any page.
//
// Auto-debounced 250ms after a 3-character minimum. Results appear
// in a dropdown directly under the input; clicking a hit navigates
// via wouter.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
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

export function GlobalLookup() {
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounced fetch.
  useEffect(() => {
    if (q.trim().length < 3) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(
          `/resupply-api/admin/lookup?q=${encodeURIComponent(q.trim())}`,
          { headers: { Accept: "application/json", ...(await authHeaders()) } },
        );
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json()) as { hits: Hit[] };
          setHits(json.hits);
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
    setLocation(href);
  }

  return (
    <div ref={wrapRef} className="relative w-72" data-testid="global-lookup">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (hits && hits.length > 0) setOpen(true);
        }}
        placeholder="Lookup phone / email / id…"
        className="w-full rounded-md border px-3 py-1.5 text-sm"
        style={{
          borderColor: "hsl(var(--penn-gold))",
          backgroundColor: "hsl(var(--surface-2))",
        }}
        aria-label="Global lookup"
      />
      {open && hits !== null && (
        <div
          className="absolute right-0 mt-1 w-full max-w-md rounded-md border bg-white shadow-lg z-50"
          style={{ borderColor: "hsl(var(--line-1))" }}
          role="listbox"
        >
          {busy && hits.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">
              No matches for &ldquo;{q}&rdquo;.
            </div>
          ) : (
            <ul>
              {hits.map((h) => (
                <li key={`${h.kind}-${h.id}`}>
                  <button
                    type="button"
                    onClick={() => navigate(h.href)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center gap-2"
                    role="option"
                  >
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
                        KIND_TONE[h.kind] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {h.kind.replace(/_/g, " ")}
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
