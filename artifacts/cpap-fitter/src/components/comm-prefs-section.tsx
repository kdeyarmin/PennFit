import React, { useEffect, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import {
  type CommunicationPreferences,
  fetchCommPrefs,
  updateCommPrefs,
} from "@/lib/account-api";
import { Button } from "@/components/ui/button";

/**
 * Communication preferences section on /account. Five email
 * categories + DND window. Customers can opt out of marketing,
 * resupply reminders, cart-abandonment nudges, and review-request
 * emails independently.
 *
 * Transactional (order shipped, refund issued) is not user-toggleable
 * here — those land via the order-detail email flow regardless.
 */
export function CommPrefsSection() {
  const [prefs, setPrefs] = useState<CommunicationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchCommPrefs();
        if (!cancelled) setPrefs(r.preferences);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: CommunicationPreferences) {
    setSaving(true);
    setError(null);
    try {
      const r = await updateCommPrefs(next);
      setPrefs(r.preferences);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="glass-card rounded-2xl p-6">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading communication preferences…
        </div>
      </section>
    );
  }
  if (!prefs) return null;

  function toggle(key: keyof CommunicationPreferences) {
    if (typeof prefs![key] !== "boolean") return;
    void save({ ...prefs!, [key]: !prefs![key] });
  }

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-comm-prefs"
    >
      <div className="flex items-center gap-2">
        <Bell className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">Communication preferences</h2>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span className="text-xs text-emerald-700 ml-auto">Saved</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Choose what you&apos;d like to hear from us. Order receipts and
        shipping notifications always send — those aren&apos;t marketing.
      </p>

      <div className="space-y-2">
        <Toggle
          label="Resupply reminders"
          description="Friendly nudges when each supply is due for replacement."
          enabled={prefs.emailResupplyReminders}
          onChange={() => toggle("emailResupplyReminders")}
          disabled={saving}
          testId="comm-toggle-resupply"
        />
        <Toggle
          label="Cart reminders"
          description="One email when you've left items in your cart for 24 hours."
          enabled={prefs.emailAbandonedCart}
          onChange={() => toggle("emailAbandonedCart")}
          disabled={saving}
          testId="comm-toggle-abandoned"
        />
        <Toggle
          label="Review requests"
          description="Quick ask 2 weeks after delivery — completely optional."
          enabled={prefs.emailReviewRequests}
          onChange={() => toggle("emailReviewRequests")}
          disabled={saving}
          testId="comm-toggle-review"
        />
        <Toggle
          label="Promotions & news"
          description="Occasional updates about new products and seasonal offers."
          enabled={prefs.emailMarketing}
          onChange={() => toggle("emailMarketing")}
          disabled={saving}
          testId="comm-toggle-marketing"
        />
      </div>

      <DndEditor prefs={prefs} onSave={save} saving={saving} />

      {error && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Toggle({
  label,
  description,
  enabled,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onChange: () => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      disabled={disabled}
      className="w-full flex items-start gap-3 p-3 rounded-lg border border-border/40 hover:border-[hsl(var(--penn-gold))]/40 transition-colors disabled:opacity-60 text-left"
      data-testid={testId}
    >
      <div className="mt-0.5">
        <span
          className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            enabled
              ? "bg-[hsl(var(--penn-navy))]"
              : "bg-slate-300"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
          {label}
        </div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}

function DndEditor({
  prefs,
  onSave,
  saving,
}: {
  prefs: CommunicationPreferences;
  onSave: (next: CommunicationPreferences) => void;
  saving: boolean;
}) {
  const [start, setStart] = useState<number | null>(prefs.dndStartHour);
  const [end, setEnd] = useState<number | null>(prefs.dndEndHour);
  const [tz, setTz] = useState<string | null>(prefs.timezone);
  const [dirty, setDirty] = useState(false);

  // Auto-detect timezone if the user has none set.
  useEffect(() => {
    if (!tz) {
      try {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected) setTz(detected);
      } catch {
        // Older browsers without DateTimeFormat resolver — skip silently.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setStart(null);
    setEnd(null);
    setDirty(true);
  }

  function set(s: number, e: number) {
    setStart(s);
    setEnd(e);
    setDirty(true);
  }

  function commit() {
    onSave({ ...prefs, dndStartHour: start, dndEndHour: end, timezone: tz });
    setDirty(false);
  }

  const enabled = start !== null && end !== null;

  return (
    <div className="rounded-lg border border-border/40 p-3 space-y-3">
      <div>
        <div className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
          Quiet hours
        </div>
        <div className="text-xs text-muted-foreground">
          {enabled
            ? `Don't email me between ${formatHour(start)} and ${formatHour(end)} (${tz ?? "your local time"}).`
            : "We'll send anytime — no quiet hours set."}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={start ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            setStart(v);
            setDirty(true);
          }}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
          aria-label="DND start hour"
        >
          <option value="">Off</option>
          {Array.from({ length: 24 }).map((_, i) => (
            <option key={i} value={i}>
              {formatHour(i)}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">to</span>
        <select
          value={end ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            setEnd(v);
            setDirty(true);
          }}
          className="rounded border border-border bg-background px-2 py-1 text-xs"
          aria-label="DND end hour"
        >
          <option value="">Off</option>
          {Array.from({ length: 24 }).map((_, i) => (
            <option key={i} value={i}>
              {formatHour(i)}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => set(22, 8)}
          disabled={saving}
          className="h-7 text-xs"
        >
          Overnight
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={reset}
          disabled={saving || (start === null && end === null)}
          className="h-7 text-xs"
        >
          Clear
        </Button>
      </div>
      {dirty && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={commit}
            disabled={
              saving ||
              (start === null) !== (end === null) ||
              (start !== null && end !== null && start === end)
            }
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>Save quiet hours</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function formatHour(h: number | null): string {
  if (h === null) return "—";
  const period = h >= 12 ? "PM" : "AM";
  const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hr}:00 ${period}`;
}
