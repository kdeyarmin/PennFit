// /admin/closures — manage office-closure windows.
//
// During a window's active range, the inbound SMS handler emits
// the configured auto-reply for any non-STOP/HELP inbound. This
// page is where CSRs declare those windows (federal holidays,
// snow days, all-hands offsites).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Clock, Plus, Repeat } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  createClosure,
  createRecurringClosure,
  endClosureNow,
  getActiveClosure,
  listOfficeClosures,
  listRecurringClosures,
  patchRecurringClosure,
  type OfficeClosure,
} from "@/lib/admin/office-closures-api";
import { getOfficeHours, putOfficeHours } from "@/lib/admin/office-hours-api";
import { listTemplates } from "@/lib/admin/message-templates-api";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const FALLBACK_CLOSED_MSG =
  "Our office is closed right now. We'll reply during business hours. Reply STOP to opt out.";

export function AdminClosuresPage() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CalendarOff className="h-6 w-6" />
          Office closures
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Schedule closure windows (federal holidays, weather, offsites). During
          an active window, inbound SMS gets the auto-reply you set here; the
          normal conversation dispatcher is bypassed for that inbound. STOP /
          HELP are always honored.
        </p>
      </header>

      <ActiveClosureBanner />
      <OfficeHoursCard />
      <NewClosureCard />
      <RecurringClosuresCard />
      <ClosureListCard />
    </div>
  );
}

function ActiveClosureBanner() {
  const { data } = useQuery({
    queryKey: ["admin", "closures", "active"] as const,
    queryFn: getActiveClosure,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  if (!data?.active) return null;
  const c = data.active;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="font-semibold mb-1">Closure in effect: {c.label}</div>
      <div className="text-xs">
        From {new Date(c.startsAt).toLocaleString()} →{" "}
        {new Date(c.endsAt).toLocaleString()}
      </div>
      <div className="text-xs mt-2 italic">"{c.autoReplyMessage}"</div>
    </div>
  );
}

function NewClosureCard() {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [autoReplyMessage, setAutoReplyMessage] = useState(
    "Our office is currently closed for the holiday. We'll respond when we reopen — STOP to opt out.",
  );

  const create = useMutation({
    mutationFn: () =>
      createClosure({
        label: label.trim(),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        autoReplyMessage: autoReplyMessage.trim(),
      }),
    onSuccess: () => {
      setLabel("");
      setStartsAt("");
      setEndsAt("");
      void qc.invalidateQueries({ queryKey: ["admin", "closures"] });
    },
  });

  const valid =
    label.trim().length > 0 &&
    startsAt &&
    endsAt &&
    new Date(endsAt) > new Date(startsAt) &&
    autoReplyMessage.trim().length > 0;

  return (
    <Card title="Schedule a closure">
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Label
          </label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value.slice(0, 200))}
            placeholder="Thanksgiving Day"
            aria-label="Label"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Starts at
          </label>
          <Input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            aria-label="Starts at"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Ends at
          </label>
          <Input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            aria-label="Ends at"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Auto-reply (max 320 chars)
          </label>
          <textarea
            value={autoReplyMessage}
            onChange={(e) => setAutoReplyMessage(e.target.value.slice(0, 320))}
            rows={3}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            aria-label="Auto-reply message"
          />
          <div className="text-[10px] text-muted-foreground mt-1">
            {autoReplyMessage.length} / 320
          </div>
        </div>
      </div>
      {create.error instanceof Error && (
        <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          {create.error.message}
        </div>
      )}
      <div className="mt-3">
        <Button
          disabled={!valid || create.isPending}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus className="h-4 w-4 mr-1" />
          Schedule
        </Button>
      </div>
    </Card>
  );
}

/**
 * Render the "Recent + upcoming" admin card showing office closures and controls to end them.
 *
 * Displays loading, error, empty, or a table of closures. Each active closure exposes an
 * "End now" action that prompts for confirmation before ending the closure and refreshing
 * the closures queries.
 *
 * @returns The card React element containing the closures UI and confirmation dialog element.
 */
function ClosureListCard() {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const queryKey = ["admin", "closures", "list"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listOfficeClosures,
  });
  const endNow = useMutation({
    mutationFn: (id: string) => endClosureNow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({
        queryKey: ["admin", "closures", "active"],
      });
    },
  });

  return (
    <Card
      title={
        <span className="flex items-center justify-between w-full gap-2">
          Recent + upcoming
          <a
            href="/resupply-api/admin/office-closures.ics"
            className="rounded border px-2 py-1 text-xs font-semibold"
            style={{
              borderColor: "hsl(var(--line-1))",
              color: "hsl(var(--penn-navy))",
            }}
            title="Download .ics to subscribe in Google Calendar / Outlook / Apple Calendar"
          >
            Subscribe (iCal)
          </a>
        </span>
      }
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.closures.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          Nothing on the calendar.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <th className="py-2 font-semibold">Label</th>
              <th className="py-2 font-semibold">Starts</th>
              <th className="py-2 font-semibold">Ends</th>
              <th className="py-2 font-semibold">State</th>
              <th className="py-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {data.closures.map((c) => (
              <ClosureRow
                key={c.id}
                row={c}
                onEndNow={async () => {
                  if (
                    !(await confirm({
                      title: "End closure now?",
                      description: `End "${c.label}" right now? Auto-reply stops immediately.`,
                      confirmLabel: "End now",
                    }))
                  )
                    return;
                  endNow.mutate(c.id);
                }}
                endPending={endNow.isPending}
              />
            ))}
          </tbody>
        </table>
      )}
      {ConfirmDialogEl}
    </Card>
  );
}

function ClosureRow({
  row,
  onEndNow,
  endPending,
}: {
  row: OfficeClosure;
  onEndNow: () => void;
  endPending: boolean;
}) {
  const now = Date.now();
  const start = new Date(row.startsAt).getTime();
  const end = new Date(row.endsAt).getTime();
  const state = end <= now ? "past" : start <= now ? "active" : "upcoming";
  return (
    <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
      <td className="py-1.5">
        <div className="font-medium">{row.label}</div>
        <div className="text-[10px] text-muted-foreground italic">
          "{row.autoReplyMessage}"
        </div>
      </td>
      <td className="py-1.5 text-xs">
        {new Date(row.startsAt).toLocaleString()}
      </td>
      <td className="py-1.5 text-xs">
        {new Date(row.endsAt).toLocaleString()}
      </td>
      <td className="py-1.5">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${
            state === "active"
              ? "bg-rose-100 text-rose-900"
              : state === "upcoming"
                ? "bg-amber-100 text-amber-900"
                : "bg-slate-200 text-slate-700"
          }`}
        >
          {state}
        </span>
      </td>
      <td className="py-1.5 text-right">
        {state === "active" && (
          <Button
            intent="ghost"
            size="sm"
            onClick={onEndNow}
            isLoading={endPending}
          >
            End now
          </Button>
        )}
      </td>
    </tr>
  );
}

// ── Office hours (weekly open-hours schedule) ────────────────────
type OfficeHoursDayState = {
  open: boolean;
  openTime: string;
  closeTime: string;
};
const DEFAULT_OFFICE_DAY: OfficeHoursDayState = {
  open: false,
  openTime: "09:00",
  closeTime: "17:00",
};

/**
 * Editor for the practice's standard weekly open hours. One row per weekday
 * (open toggle + start/end time). Saved via PUT (replace-the-whole-schedule).
 * The company calendar reads this to shade time outside office hours.
 */
function OfficeHoursCard() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "office-hours"] as const,
    queryFn: getOfficeHours,
  });
  const [days, setDays] = useState<OfficeHoursDayState[]>(() =>
    Array.from({ length: 7 }, () => ({ ...DEFAULT_OFFICE_DAY })),
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!data || loaded) return;
    const next = Array.from({ length: 7 }, () => ({ ...DEFAULT_OFFICE_DAY }));
    for (const w of data.windows) {
      if (w.dayOfWeek >= 0 && w.dayOfWeek <= 6) {
        next[w.dayOfWeek] = {
          open: true,
          openTime: w.openTimeUtc.slice(0, 5),
          closeTime: w.closeTimeUtc.slice(0, 5),
        };
      }
    }
    setDays(next);
    setLoaded(true);
  }, [data, loaded]);

  const save = useMutation({
    mutationFn: () =>
      putOfficeHours(
        days.flatMap((d, i) =>
          d.open
            ? [
                {
                  dayOfWeek: i,
                  openTimeUtc: `${d.openTime}:00`,
                  closeTimeUtc: `${d.closeTime}:00`,
                },
              ]
            : [],
        ),
      ),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["admin", "office-hours"] }),
  });

  const valid = days.every((d) => !d.open || d.closeTime > d.openTime);

  function setDay(i: number, patch: Partial<OfficeHoursDayState>) {
    setDays((prev) =>
      prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Office hours
        </span>
      }
    >
      <p className="text-xs text-muted-foreground mb-3">
        Your standard weekly open hours. The company calendar shades time
        outside these hours as unavailable and defaults new appointments into
        the open window. Times are UTC.
      </p>
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="space-y-1.5">
            {days.map((d, i) => (
              <div
                key={WEEKDAY_NAMES[i]}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <label className="flex w-32 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={d.open}
                    onChange={(e) => setDay(i, { open: e.target.checked })}
                    aria-label={`${WEEKDAY_NAMES[i]} open`}
                  />
                  <span
                    className={d.open ? "font-medium" : "text-muted-foreground"}
                  >
                    {WEEKDAY_NAMES[i]}
                  </span>
                </label>
                <input
                  type="time"
                  value={d.openTime}
                  disabled={!d.open}
                  onChange={(e) => setDay(i, { openTime: e.target.value })}
                  aria-label={`${WEEKDAY_NAMES[i]} open time`}
                  className="rounded border px-2 py-1 text-sm disabled:opacity-50"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                />
                <span className="text-muted-foreground">to</span>
                <input
                  type="time"
                  value={d.closeTime}
                  disabled={!d.open}
                  onChange={(e) => setDay(i, { closeTime: e.target.value })}
                  aria-label={`${WEEKDAY_NAMES[i]} close time`}
                  className="rounded border px-2 py-1 text-sm disabled:opacity-50"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                />
                {d.open && d.closeTime <= d.openTime && (
                  <span className="text-xs text-rose-700">
                    end must be after start
                  </span>
                )}
              </div>
            ))}
          </div>
          {save.error instanceof Error && (
            <div className="mt-3 text-xs text-rose-700">
              {save.error.message}
            </div>
          )}
          <div className="mt-3">
            <Button
              size="sm"
              disabled={!valid || save.isPending}
              isLoading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save office hours
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Recurring (weekly) blackouts ─────────────────────────────────
/**
 * Standing weekly closures (e.g. every weekend). One-click "Block all
 * weekends" plus a custom day/time form. Each rule drives the inbound-SMS
 * auto-reply and shades the matching weekday on the company calendar.
 */
function RecurringClosuresCard() {
  const qc = useQueryClient();
  const queryKey = ["admin", "closures", "recurring"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listRecurringClosures,
  });

  // Pre-fill the auto-reply from the seeded "office hours" SMS template so a
  // weekend blackout speaks the practice's standard hours.
  const officeHoursTpl = useQuery({
    queryKey: ["admin", "message-templates", "office_hours", "sms"] as const,
    queryFn: () =>
      listTemplates({ templateKey: "office_hours", channel: "sms" }),
    staleTime: 5 * 60_000,
  });
  const defaultMsg = (
    officeHoursTpl.data?.templates?.[0]?.bodyText || FALLBACK_CLOSED_MSG
  ).slice(0, 320);

  const rules = data?.rules ?? [];
  const hasSat = rules.some((r) => r.dayOfWeek === 6);
  const hasSun = rules.some((r) => r.dayOfWeek === 0);
  const bothWeekend = hasSat && hasSun;

  const invalidate = () => void qc.invalidateQueries({ queryKey });

  const blockWeekends = useMutation({
    mutationFn: async () => {
      const toMake: Array<{ dow: number; label: string }> = [];
      if (!hasSat) toMake.push({ dow: 6, label: "Weekend (Saturday)" });
      if (!hasSun) toMake.push({ dow: 0, label: "Weekend (Sunday)" });
      for (const d of toMake) {
        await createRecurringClosure({
          label: d.label,
          dayOfWeek: d.dow,
          startTimeUtc: "00:00:00",
          endTimeUtc: "23:59:59",
          autoReplyMessage: defaultMsg,
        });
      }
    },
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) =>
      patchRecurringClosure(v.id, { active: v.active }),
    onSuccess: invalidate,
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Repeat className="h-4 w-4" />
          Recurring blackouts
        </span>
      }
    >
      <p className="text-xs text-muted-foreground mb-3">
        Standing weekly closures. During an active window inbound SMS gets the
        auto-reply and the company calendar shades that weekday as closed.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          intent="secondary"
          size="sm"
          disabled={bothWeekend || blockWeekends.isPending}
          isLoading={blockWeekends.isPending}
          onClick={() => blockWeekends.mutate()}
        >
          <CalendarOff className="mr-1 h-4 w-4" />
          {bothWeekend ? "Weekends blocked" : "Block all weekends"}
        </Button>
        {blockWeekends.error instanceof Error && (
          <span className="text-xs text-rose-700">
            {blockWeekends.error.message}
          </span>
        )}
      </div>

      <NewRecurringClosureForm defaultMsg={defaultMsg} onCreated={invalidate} />

      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : rules.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          No recurring blackouts yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rules.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 rounded border p-2 text-sm"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <div className="min-w-0">
                <div className="font-medium">
                  {WEEKDAY_NAMES[r.dayOfWeek] ?? `Day ${r.dayOfWeek}`}{" "}
                  <span className="text-xs text-muted-foreground">
                    {r.startTimeUtc.slice(0, 5)}–{r.endTimeUtc.slice(0, 5)} UTC
                  </span>
                </div>
                <div className="truncate text-[10px] italic text-muted-foreground">
                  &ldquo;{r.autoReplyMessage}&rdquo;
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={r.active}
                  disabled={toggle.isPending}
                  onChange={(e) =>
                    toggle.mutate({ id: r.id, active: e.target.checked })
                  }
                />
                Active
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NewRecurringClosureForm({
  defaultMsg,
  onCreated,
}: {
  defaultMsg: string;
  onCreated: () => void;
}) {
  const [dayOfWeek, setDayOfWeek] = useState(6);
  const [start, setStart] = useState("00:00");
  const [end, setEnd] = useState("23:59");
  const [msg, setMsg] = useState(defaultMsg);
  const [touchedMsg, setTouchedMsg] = useState(false);

  // Track the seeded default until the user edits the message themselves.
  useEffect(() => {
    if (!touchedMsg) setMsg(defaultMsg);
  }, [defaultMsg, touchedMsg]);

  const create = useMutation({
    mutationFn: () =>
      createRecurringClosure({
        label: `Every ${WEEKDAY_NAMES[dayOfWeek]}`,
        dayOfWeek,
        startTimeUtc: `${start}:00`,
        endTimeUtc: `${end}:00`,
        autoReplyMessage: msg.trim().slice(0, 320),
      }),
    onSuccess: () => {
      setTouchedMsg(false);
      onCreated();
    },
  });

  const valid = end > start && msg.trim().length > 0;

  return (
    <div
      className="rounded border border-dashed p-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Day
          </label>
          <select
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(Number(e.target.value))}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            aria-label="Day of week"
          >
            {WEEKDAY_NAMES.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Start (UTC)
          </label>
          <Input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            aria-label="Start time"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            End (UTC)
          </label>
          <Input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="End time"
          />
        </div>
      </div>
      <div className="mt-2">
        <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
          Auto-reply (max 320 chars)
        </label>
        <textarea
          value={msg}
          onChange={(e) => {
            setTouchedMsg(true);
            setMsg(e.target.value.slice(0, 320));
          }}
          rows={2}
          className="w-full rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
          aria-label="Recurring auto-reply message"
        />
      </div>
      {create.error instanceof Error && (
        <div className="mt-2 text-xs text-rose-700">{create.error.message}</div>
      )}
      <div className="mt-2">
        <Button
          size="sm"
          disabled={!valid || create.isPending}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add recurring blackout
        </Button>
      </div>
    </div>
  );
}
