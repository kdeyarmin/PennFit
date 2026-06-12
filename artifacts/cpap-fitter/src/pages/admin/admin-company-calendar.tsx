// /admin/company-calendar — shared, staff-wide appointment calendar.
//
// Any signed-in team member can place patient appointments (virtual /
// in-person fittings & setups, follow-ups, consultations) on a month grid
// that the whole company sees, track each one through its lifecycle
// (scheduled → completed / canceled / no-show), filter by type or owner,
// and drill into a day. These are the confirmed, scheduled events.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  CalendarDays,
  CalendarOff,
  Check,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import {
  getListPatientsQueryKey,
  useGetAdminMe,
  useListPatients,
} from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { fullName } from "@/lib/admin/format";
import {
  type CalendarEventStatus,
  type CalendarEventType,
  type CompanyCalendarEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  listAssignableStaff,
  listCompanyCalendar,
  updateCalendarEvent,
} from "@/lib/admin/company-calendar-api";
import {
  createClosure,
  listOfficeClosures,
  listRecurringClosures,
} from "@/lib/admin/office-closures-api";
import { getOfficeHours } from "@/lib/admin/office-hours-api";
import { listTemplates } from "@/lib/admin/message-templates-api";

// ── Appointment-type metadata ────────────────────────────────────
// Order matters: drives the legend + the <select> order. Keep the keys
// in lock-step with the server Zod enum + the DB CHECK constraint.
const EVENT_TYPE_ORDER: readonly CalendarEventType[] = [
  "fitting_in_person",
  "fitting_virtual",
  "setup_in_person",
  "setup_virtual",
  "follow_up",
  "consultation",
  "other",
];

const EVENT_TYPE_META: Record<
  CalendarEventType,
  { label: string; dot: string; chip: string }
> = {
  fitting_in_person: {
    label: "In-person fitting",
    dot: "bg-emerald-500",
    chip: "bg-emerald-100 text-emerald-900 border-emerald-200",
  },
  fitting_virtual: {
    label: "Virtual fitting",
    dot: "bg-teal-500",
    chip: "bg-teal-100 text-teal-900 border-teal-200",
  },
  setup_in_person: {
    label: "In-person setup",
    dot: "bg-indigo-500",
    chip: "bg-indigo-100 text-indigo-900 border-indigo-200",
  },
  setup_virtual: {
    label: "Virtual setup",
    dot: "bg-sky-500",
    chip: "bg-sky-100 text-sky-900 border-sky-200",
  },
  follow_up: {
    label: "Follow-up",
    dot: "bg-amber-500",
    chip: "bg-amber-100 text-amber-900 border-amber-200",
  },
  consultation: {
    label: "Consultation",
    dot: "bg-violet-500",
    chip: "bg-violet-100 text-violet-900 border-violet-200",
  },
  other: {
    label: "Other",
    dot: "bg-slate-400",
    chip: "bg-slate-100 text-slate-700 border-slate-200",
  },
};

type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const STATUS_ORDER: readonly CalendarEventStatus[] = [
  "scheduled",
  "completed",
  "no_show",
  "canceled",
];

const STATUS_META: Record<
  CalendarEventStatus,
  { label: string; variant: BadgeVariant }
> = {
  scheduled: { label: "Scheduled", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  no_show: { label: "No-show", variant: "warning" },
  canceled: { label: "Canceled", variant: "muted" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// ── Date helpers ─────────────────────────────────────────────────
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// A fixed 6-week (42-cell) grid so the layout never jumps month to month.
function buildMonthGrid(viewDate: Date): Date[] {
  const first = startOfMonth(viewDate);
  const gridStart = new Date(
    first.getFullYear(),
    first.getMonth(),
    1 - first.getDay(),
  );
  return Array.from(
    { length: 42 },
    (_, i) =>
      new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + i,
      ),
  );
}

// Format a Date as a `datetime-local` input value in the viewer's local
// timezone (the input is timezone-naive; `new Date(value)` reads it back
// as local time, so this round-trips cleanly).
function fmtLocalInput(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function rangeLabel(startIso: string, endIso: string): string {
  return `${timeLabel(startIso)} – ${timeLabel(endIso)}`;
}

function durationLabel(startIso: string, endIso: string): string {
  const min = Math.max(
    0,
    Math.round(
      (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
    ),
  );
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const MONTH_FMT = new Intl.DateTimeFormat([], {
  month: "long",
  year: "numeric",
});

const DAY_FMT = new Intl.DateTimeFormat([], {
  weekday: "long",
  month: "long",
  day: "numeric",
});

type SelectedPatient = { id: string; firstName: string; lastName: string };

type EditorState =
  | { mode: "create"; date: Date }
  | { mode: "edit"; event: CompanyCalendarEvent };

const CALENDAR_KEY = ["admin", "company-calendar"] as const;

const FALLBACK_BLOCK_DAY_MSG =
  "Our office is closed today. We'll reply when we reopen. Reply STOP to opt out.";

// ── Page ─────────────────────────────────────────────────────────
export function AdminCompanyCalendarPage() {
  const [viewDate, setViewDate] = useState<Date>(() =>
    startOfMonth(new Date()),
  );
  const [selectedDay, setSelectedDay] = useState<Date>(() =>
    startOfDay(new Date()),
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<
    ReadonlySet<CalendarEventType>
  >(() => new Set());
  const [onlyMine, setOnlyMine] = useState(false);

  const me = useGetAdminMe();
  const myUserId = me.data?.userId ?? null;

  const grid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const rangeFromIso = grid[0].toISOString();
  const rangeToIso = new Date(
    grid[41].getFullYear(),
    grid[41].getMonth(),
    grid[41].getDate() + 1,
  ).toISOString();

  const queryKey = [
    ...CALENDAR_KEY,
    viewDate.getFullYear(),
    viewDate.getMonth(),
  ] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listCompanyCalendar(rangeFromIso, rangeToIso),
  });

  const filtered = useMemo(() => {
    return (data?.events ?? []).filter(
      (e) =>
        !hiddenTypes.has(e.eventType) &&
        (!onlyMine || e.createdByUserId === myUserId),
    );
  }, [data, hiddenTypes, onlyMine, myUserId]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CompanyCalendarEvent[]>();
    for (const ev of filtered) {
      const k = dateKey(new Date(ev.startsAt));
      const arr = map.get(k);
      if (arr) arr.push(ev);
      else map.set(k, [ev]);
    }
    return map;
  }, [filtered]);

  const todayKey = dateKey(new Date());
  const viewMonth = viewDate.getMonth();
  const selectedKey = dateKey(selectedDay);
  const selectedEvents = eventsByDay.get(selectedKey) ?? [];

  // ── Blackouts / office-hours overlay ───────────────────────────
  // Pulled from the closures + office-hours admin surfaces so the calendar
  // visibly marks days the practice is closed. Shared query keys reuse the
  // closures-page cache; "Block this day" invalidates them.
  const closuresQuery = useQuery({
    queryKey: ["admin", "closures", "list"] as const,
    queryFn: listOfficeClosures,
    staleTime: 60_000,
  });
  const recurringQuery = useQuery({
    queryKey: ["admin", "closures", "recurring"] as const,
    queryFn: listRecurringClosures,
    staleTime: 60_000,
  });
  const officeHoursQuery = useQuery({
    queryKey: ["admin", "office-hours"] as const,
    queryFn: getOfficeHours,
    staleTime: 60_000,
  });

  const officeHoursWeekdays = useMemo(
    () =>
      new Set((officeHoursQuery.data?.windows ?? []).map((w) => w.dayOfWeek)),
    [officeHoursQuery.data],
  );
  const officeHoursConfigured =
    (officeHoursQuery.data?.windows ?? []).length > 0;
  const recurringClosedWeekdays = useMemo(() => {
    const s = new Set<number>();
    for (const r of recurringQuery.data?.rules ?? []) {
      // An "all day" recurring rule closes the whole weekday.
      if (
        r.active &&
        r.startTimeUtc <= "00:30:00" &&
        r.endTimeUtc >= "23:00:00"
      )
        s.add(r.dayOfWeek);
    }
    return s;
  }, [recurringQuery.data]);

  // Short label when a calendar day is closed (one-off closure overlapping
  // the day, a recurring all-day rule, or — once office hours are set — a
  // weekday with no open window). Null when the day is open.
  function dayClosedLabel(day: Date): string | null {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = dayStart + 86_400_000;
    for (const c of closuresQuery.data?.closures ?? []) {
      const s = new Date(c.startsAt).getTime();
      const e = new Date(c.endsAt).getTime();
      if (s < dayEnd && e > dayStart) return c.label || "Closed";
    }
    const dow = day.getDay();
    if (recurringClosedWeekdays.has(dow)) return "Closed";
    if (officeHoursConfigured && !officeHoursWeekdays.has(dow)) return "Closed";
    return null;
  }

  function goToMonth(offset: number) {
    const next = new Date(viewDate.getFullYear(), viewMonth + offset, 1);
    setViewDate(next);
    setSelectedDay(next); // 1st of the new month → panel stays in-window
  }
  function goToday() {
    setViewDate(startOfMonth(new Date()));
    setSelectedDay(startOfDay(new Date()));
  }

  function toggleType(t: CalendarEventType) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <div className="admin-root p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CalendarDays className="h-6 w-6" />
          Company calendar
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          A shared schedule of patient appointments — virtual &amp; in-person
          fittings and setups, follow-ups, and consultations. Everyone on the
          team can see and edit it; mark each one completed, canceled, or a
          no-show as the day unfolds.
        </p>
      </header>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous month"
            className="rounded border p-1.5 hover:bg-slate-50"
            style={{ borderColor: "hsl(var(--line-1))" }}
            onClick={() => goToMonth(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-[10rem] text-center text-lg font-semibold">
            {MONTH_FMT.format(viewDate)}
          </div>
          <button
            type="button"
            aria-label="Next month"
            className="rounded border p-1.5 hover:bg-slate-50"
            style={{ borderColor: "hsl(var(--line-1))" }}
            onClick={() => goToMonth(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <Button intent="secondary" size="sm" onClick={goToday}>
            Today
          </Button>
          <span className="ml-1 text-xs text-muted-foreground">
            {filtered.length}{" "}
            {filtered.length === 1 ? "appointment" : "appointments"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOnlyMine((v) => !v)}
            aria-pressed={onlyMine}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              onlyMine
                ? "bg-[hsl(var(--penn-navy))] text-white"
                : "hover:bg-slate-50"
            }`}
            style={onlyMine ? undefined : { borderColor: "hsl(var(--line-1))" }}
          >
            Only mine
          </button>
          <Button
            onClick={() => setEditor({ mode: "create", date: selectedDay })}
          >
            <Plus className="h-4 w-4 mr-1" />
            New appointment
          </Button>
        </div>
      </div>

      {/* Legend — click a type to show/hide it */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        {EVENT_TYPE_ORDER.map((t) => {
          const hidden = hiddenTypes.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              aria-pressed={!hidden}
              title={hidden ? "Show this type" : "Hide this type"}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 transition-opacity ${
                hidden ? "opacity-40" : ""
              }`}
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${EVENT_TYPE_META[t].dot}`}
              />
              <span className={hidden ? "line-through" : ""}>
                {EVENT_TYPE_META[t].label}
              </span>
            </button>
          );
        })}
      </div>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <div
          className="overflow-x-auto rounded-lg border"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div className="min-w-[44rem]">
            {/* Weekday header */}
            <div
              className="grid grid-cols-7 border-b text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {WEEKDAYS.map((w) => (
                <div key={w} className="px-2 py-2 text-center">
                  {w}
                </div>
              ))}
            </div>
            {/* Day grid */}
            <div className="grid grid-cols-7">
              {grid.map((day) => {
                const inMonth = day.getMonth() === viewMonth;
                const isToday = dateKey(day) === todayKey;
                const isSelected = dateKey(day) === selectedKey;
                const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                const dayEvents = eventsByDay.get(dateKey(day)) ?? [];
                const closedLabel = inMonth ? dayClosedLabel(day) : null;
                const cellBg = isSelected
                  ? "bg-[hsl(var(--penn-navy)/0.06)] ring-1 ring-inset ring-[hsl(var(--penn-navy)/0.35)]"
                  : !inMonth
                    ? "bg-slate-50/70"
                    : closedLabel
                      ? "bg-rose-50/40"
                      : isWeekend
                        ? "bg-slate-50/40"
                        : "bg-white";
                return (
                  <div
                    key={dateKey(day)}
                    className={`group relative min-h-[6.5rem] border-b border-r p-1 ${cellBg}`}
                    style={{ borderColor: "hsl(var(--line-2))" }}
                  >
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setSelectedDay(startOfDay(day))}
                        aria-label={`View ${day.toLocaleDateString()}`}
                        aria-current={isSelected ? "date" : undefined}
                        className="rounded px-1 py-0.5 hover:bg-slate-100"
                      >
                        <span
                          className={`inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full text-xs ${
                            isToday
                              ? "bg-[hsl(var(--penn-navy))] font-semibold text-white"
                              : inMonth
                                ? "text-slate-700"
                                : "text-slate-400"
                          }`}
                        >
                          {day.getDate()}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setEditor({ mode: "create", date: startOfDay(day) })
                        }
                        aria-label={`Add appointment on ${day.toLocaleDateString()}`}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-slate-100 focus:opacity-100 group-hover:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {closedLabel && (
                      <div
                        className="mt-0.5 truncate rounded bg-rose-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-rose-700"
                        title={closedLabel}
                      >
                        {closedLabel}
                      </div>
                    )}
                    <div className="mt-1 space-y-1">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <EventChip
                          key={ev.id}
                          ev={ev}
                          onClick={() => setEditor({ mode: "edit", event: ev })}
                        />
                      ))}
                      {dayEvents.length > 3 && (
                        <button
                          type="button"
                          onClick={() => setSelectedDay(startOfDay(day))}
                          className="px-1 text-[10px] font-medium text-muted-foreground hover:underline"
                        >
                          +{dayEvents.length - 3} more
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <SelectedDayPanel
          day={selectedDay}
          events={selectedEvents}
          isPending={isPending && !isError}
          closedLabel={dayClosedLabel(selectedDay)}
          onAdd={() => setEditor({ mode: "create", date: selectedDay })}
          onEdit={(ev) => setEditor({ mode: "edit", event: ev })}
        />
        <UpcomingCard
          events={filtered}
          isPending={isPending && !isError}
          onOpen={(ev) => setEditor({ mode: "edit", event: ev })}
        />
      </div>

      {editor && (
        <EventEditor
          state={editor}
          closedLabelForDate={dayClosedLabel}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

// ── Grid chip ────────────────────────────────────────────────────
function EventChip({
  ev,
  onClick,
}: {
  ev: CompanyCalendarEvent;
  onClick: () => void;
}) {
  const inactive = ev.status === "canceled" || ev.status === "no_show";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${rangeLabel(ev.startsAt, ev.endsAt)} · ${
        EVENT_TYPE_META[ev.eventType].label
      } · ${fullName(ev.patientFirstName, ev.patientLastName)} · ${
        STATUS_META[ev.status].label
      }`}
      className={`block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] ${
        EVENT_TYPE_META[ev.eventType].chip
      } ${inactive ? "opacity-60" : ""}`}
    >
      {ev.status === "completed" && (
        <Check className="mr-0.5 inline h-3 w-3 align-[-1px]" />
      )}
      <span className={`font-semibold ${inactive ? "line-through" : ""}`}>
        {timeLabel(ev.startsAt)}
      </span>{" "}
      <span className={inactive ? "line-through" : ""}>
        {fullName(ev.patientFirstName, ev.patientLastName)}
      </span>
    </button>
  );
}

// ── Selected-day detail panel ────────────────────────────────────
function SelectedDayPanel({
  day,
  events,
  isPending,
  closedLabel,
  onAdd,
  onEdit,
}: {
  day: Date;
  events: CompanyCalendarEvent[];
  isPending: boolean;
  closedLabel: string | null;
  onAdd: () => void;
  onEdit: (ev: CompanyCalendarEvent) => void;
}) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  // Pre-fill the closure auto-reply from the seeded "office hours" SMS
  // template so a one-click block-day speaks the practice's standard hours,
  // matching the closures page (falls back to a static line).
  const officeHoursTpl = useQuery({
    queryKey: ["admin", "message-templates", "office_hours", "sms"] as const,
    queryFn: () =>
      listTemplates({ templateKey: "office_hours", channel: "sms" }),
    staleTime: 5 * 60_000,
  });
  const blockDayMessage = (
    officeHoursTpl.data?.templates?.[0]?.bodyText || FALLBACK_BLOCK_DAY_MSG
  ).slice(0, 320);
  const blockDay = useMutation({
    mutationFn: () => {
      const s = startOfDay(day);
      const e = new Date(
        s.getFullYear(),
        s.getMonth(),
        s.getDate(),
        23,
        59,
        59,
      );
      return createClosure({
        label: `Closed ${s.toLocaleDateString()}`,
        startsAt: s.toISOString(),
        endsAt: e.toISOString(),
        autoReplyMessage: blockDayMessage,
      });
    },
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["admin", "closures"] }),
  });

  return (
    <Card
      title={
        <span className="flex w-full items-center justify-between gap-2">
          <span>{DAY_FMT.format(day)}</span>
          <span className="flex items-center gap-2">
            <Button
              intent="ghost"
              size="sm"
              isLoading={blockDay.isPending}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: "Block this day?",
                    description:
                      "Mark this whole day closed? Inbound SMS gets the office-closed auto-reply and the day shows as closed on the calendar. You can undo it from Office closures.",
                    confirmLabel: "Block day",
                  }))
                )
                  return;
                blockDay.mutate();
              }}
            >
              <CalendarOff className="mr-1 h-4 w-4" />
              Block day
            </Button>
            <Button intent="secondary" size="sm" onClick={onAdd}>
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </span>
        </span>
      }
    >
      {closedLabel && (
        <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
          This day is marked closed ({closedLabel}).
        </div>
      )}
      {blockDay.error instanceof Error && (
        <div className="mb-3 text-xs text-rose-700">
          {blockDay.error.message}
        </div>
      )}
      {isPending ? (
        <Spinner />
      ) : events.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          No appointments on this day.
        </p>
      ) : (
        <ul className="space-y-3">
          {events.map((ev) => (
            <DayEventRow key={ev.id} ev={ev} onEdit={() => onEdit(ev)} />
          ))}
        </ul>
      )}
      {ConfirmDialogEl}
    </Card>
  );
}

function DayEventRow({
  ev,
  onEdit,
}: {
  ev: CompanyCalendarEvent;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: CALENDAR_KEY });

  const setStatus = useMutation({
    mutationFn: (status: CalendarEventStatus) =>
      updateCalendarEvent(ev.id, { status }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () => deleteCalendarEvent(ev.id),
    onSuccess: invalidate,
  });

  const inactive = ev.status === "canceled" || ev.status === "no_show";

  return (
    <li
      className="rounded-lg border p-3"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${EVENT_TYPE_META[ev.eventType].dot}`}
            />
            <Link
              href={`/admin/patients/${ev.patientId}`}
              className={`font-medium hover:underline ${inactive ? "line-through" : ""}`}
            >
              {fullName(ev.patientFirstName, ev.patientLastName)}
            </Link>
            <Badge variant={STATUS_META[ev.status].variant}>
              {STATUS_META[ev.status].label}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {EVENT_TYPE_META[ev.eventType].label} ·{" "}
            {rangeLabel(ev.startsAt, ev.endsAt)} (
            {durationLabel(ev.startsAt, ev.endsAt)})
          </div>
          {ev.location && (
            <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="break-all">{ev.location}</span>
            </div>
          )}
          {ev.notes && (
            <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600">
              {ev.notes}
            </div>
          )}
          {ev.createdByEmail && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              Added by {ev.createdByEmail}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Edit appointment"
            onClick={onEdit}
            className="rounded p-1 text-muted-foreground hover:bg-slate-100"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Delete appointment"
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Delete appointment?",
                  description:
                    "Remove this appointment from the company calendar? This can't be undone.",
                  confirmLabel: "Delete",
                }))
              )
                return;
              del.mutate();
            }}
            className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Status
        </label>
        <select
          value={ev.status}
          disabled={setStatus.isPending}
          onChange={(e) =>
            setStatus.mutate(e.target.value as CalendarEventStatus)
          }
          className="rounded border px-2 py-1 text-xs"
          style={{ borderColor: "hsl(var(--line-1))" }}
          aria-label="Set status"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
      </div>
      {ConfirmDialogEl}
    </li>
  );
}

// ── Upcoming list ────────────────────────────────────────────────
function UpcomingCard({
  events,
  isPending,
  onOpen,
}: {
  events: CompanyCalendarEvent[];
  isPending: boolean;
  onOpen: (ev: CompanyCalendarEvent) => void;
}) {
  const now = Date.now();
  // "Upcoming" = still going to happen: scheduled and not yet ended.
  // Completed / canceled / no-show have all reached a terminal state.
  const upcoming = events
    .filter(
      (e) => e.status === "scheduled" && new Date(e.endsAt).getTime() >= now,
    )
    .slice(0, 12);
  return (
    <Card title="Upcoming appointments">
      {isPending ? (
        <Spinner />
      ) : upcoming.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          Nothing scheduled in this window.
        </p>
      ) : (
        <ul className="divide-y" style={{ borderColor: "hsl(var(--line-2))" }}>
          {upcoming.map((ev) => (
            <li key={ev.id}>
              <button
                type="button"
                onClick={() => onOpen(ev)}
                className="flex w-full items-center gap-3 py-2 text-left hover:bg-slate-50"
              >
                <span
                  className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${EVENT_TYPE_META[ev.eventType].dot}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">
                    {fullName(ev.patientFirstName, ev.patientLastName)}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {EVENT_TYPE_META[ev.eventType].label}
                  </span>
                  {ev.location && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      <span className="max-w-[12rem] truncate">
                        {ev.location}
                      </span>
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(ev.startsAt).toLocaleString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Create / edit modal ──────────────────────────────────────────
function EventEditor({
  state,
  closedLabelForDate,
  onClose,
}: {
  state: EditorState;
  closedLabelForDate: (d: Date) => string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const isEdit = state.mode === "edit";

  const [patient, setPatient] = useState<SelectedPatient | null>(() =>
    state.mode === "edit"
      ? {
          id: state.event.patientId,
          firstName: state.event.patientFirstName ?? "",
          lastName: state.event.patientLastName ?? "",
        }
      : null,
  );
  const [eventType, setEventType] = useState<CalendarEventType>(() =>
    state.mode === "edit" ? state.event.eventType : "fitting_in_person",
  );
  const [status, setStatus] = useState<CalendarEventStatus>(() =>
    state.mode === "edit" ? state.event.status : "scheduled",
  );
  const [startsAt, setStartsAt] = useState<string>(() =>
    state.mode === "edit"
      ? fmtLocalInput(new Date(state.event.startsAt))
      : fmtLocalInput(
          new Date(
            state.date.getFullYear(),
            state.date.getMonth(),
            state.date.getDate(),
            9,
            0,
          ),
        ),
  );
  const [endsAt, setEndsAt] = useState<string>(() =>
    state.mode === "edit"
      ? fmtLocalInput(new Date(state.event.endsAt))
      : fmtLocalInput(
          new Date(
            state.date.getFullYear(),
            state.date.getMonth(),
            state.date.getDate(),
            9,
            30,
          ),
        ),
  );
  const [location, setLocation] = useState<string>(() =>
    state.mode === "edit" ? (state.event.location ?? "") : "",
  );
  const [notes, setNotes] = useState<string>(() =>
    state.mode === "edit" ? (state.event.notes ?? "") : "",
  );
  const [assignedToUserId, setAssignedToUserId] = useState<string>(() =>
    state.mode === "edit" ? (state.event.assignedToUserId ?? "") : "",
  );

  // Staff roster for the "Assign to" picker. Served by the calendar's own
  // requireAdmin-gated endpoint (not admin-only /admin/team) and already
  // filtered to the effectively-active roster, so agents can assign too.
  const staffQuery = useQuery({
    queryKey: ["admin", "assignable-staff"] as const,
    queryFn: listAssignableStaff,
    staleTime: 60_000,
  });
  const assignableMembers = staffQuery.data?.staff ?? [];
  // If the current assignee isn't in the active roster (revoked, or not yet
  // loaded), keep them selectable so editing doesn't silently drop them.
  const currentAssigneeMissing =
    state.mode === "edit" &&
    !!state.event.assignedToUserId &&
    !assignableMembers.some((m) => m.userId === state.event.assignedToUserId);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: CALENDAR_KEY });

  const save = useMutation({
    mutationFn: async () => {
      const base = {
        patientId: patient!.id,
        eventType,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        location: location.trim() || null,
        notes: notes.trim() || null,
        assignedToUserId: assignedToUserId || null,
      };
      if (state.mode === "edit") {
        await updateCalendarEvent(state.event.id, { ...base, status });
      } else {
        await createCalendarEvent({ ...base, status });
      }
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const del = useMutation({
    mutationFn: () =>
      deleteCalendarEvent(state.mode === "edit" ? state.event.id : ""),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const valid =
    patient != null &&
    startsAt !== "" &&
    endsAt !== "" &&
    new Date(endsAt) >= new Date(startsAt);

  // Non-blocking heads-up if the chosen start lands on a closed day.
  const startClosedLabel = startsAt
    ? closedLabelForDate(new Date(startsAt))
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="admin-root w-full max-w-lg rounded-xl bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "Edit appointment" : "New appointment"}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <h2 className="text-base font-semibold">
            {isEdit ? "Edit appointment" : "New appointment"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div>
            <FieldLabel>Patient</FieldLabel>
            <PatientPicker value={patient} onChange={setPatient} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Appointment type</FieldLabel>
              <select
                value={eventType}
                onChange={(e) =>
                  setEventType(e.target.value as CalendarEventType)
                }
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
                aria-label="Appointment type"
              >
                {EVENT_TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_META[t].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel>Status</FieldLabel>
              <select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as CalendarEventStatus)
                }
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
                aria-label="Status"
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>Starts</FieldLabel>
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => {
                  const next = e.target.value;
                  setStartsAt(next);
                  // Keep end ≥ start: nudge end forward 30m if it went stale.
                  if (next && (!endsAt || new Date(endsAt) < new Date(next))) {
                    setEndsAt(
                      fmtLocalInput(
                        new Date(new Date(next).getTime() + 30 * 60_000),
                      ),
                    );
                  }
                }}
                aria-label="Starts at"
              />
            </div>
            <div>
              <FieldLabel>Ends</FieldLabel>
              <Input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                aria-label="Ends at"
              />
            </div>
          </div>

          {startClosedLabel && (
            <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              Heads up — this falls on a day marked closed ({startClosedLabel}).
            </div>
          )}

          <div>
            <FieldLabel>Location / video link (optional)</FieldLabel>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value.slice(0, 300))}
              placeholder="Suite 200, or a video-call link"
              aria-label="Location or video link"
            />
          </div>

          <div>
            <FieldLabel>Notes (optional)</FieldLabel>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
              rows={3}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{ borderColor: "hsl(var(--line-1))" }}
              aria-label="Notes"
            />
          </div>

          <div>
            <FieldLabel>Assign to (optional)</FieldLabel>
            <select
              value={assignedToUserId}
              onChange={(e) => setAssignedToUserId(e.target.value)}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{ borderColor: "hsl(var(--line-1))" }}
              aria-label="Assign to"
            >
              <option value="">Unassigned</option>
              {assignableMembers.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName ?? m.email}
                </option>
              ))}
              {state.mode === "edit" && currentAssigneeMissing && (
                <option value={state.event.assignedToUserId ?? ""}>
                  {state.event.assignedToEmail ?? "Current assignee"}
                </option>
              )}
            </select>
            {assignedToUserId &&
              assignedToUserId !==
                (state.mode === "edit"
                  ? (state.event.assignedToUserId ?? "")
                  : "") && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  They&apos;ll get an email and see it on their dashboard.
                </p>
              )}
          </div>

          {isEdit && state.event.createdByEmail && (
            <p className="text-[10px] text-muted-foreground">
              Added by {state.event.createdByEmail}
            </p>
          )}

          {save.error instanceof Error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
              {save.error.message}
            </div>
          )}
          {del.error instanceof Error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
              {del.error.message}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-between gap-2 border-t px-5 py-3"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div>
            {isEdit && (
              <Button
                intent="ghost"
                size="sm"
                isLoading={del.isPending}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Delete appointment?",
                      description:
                        "Remove this appointment from the company calendar? This can't be undone.",
                      confirmLabel: "Delete",
                    }))
                  )
                    return;
                  del.mutate();
                }}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button intent="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!valid || save.isPending}
              isLoading={save.isPending}
              onClick={() => save.mutate()}
            >
              {isEdit ? "Save changes" : "Add appointment"}
            </Button>
          </div>
        </div>
      </div>
      {ConfirmDialogEl}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </label>
  );
}

// ── Patient typeahead ────────────────────────────────────────────
function PatientPicker({
  value,
  onChange,
}: {
  value: SelectedPatient | null;
  onChange: (p: SelectedPatient | null) => void;
}) {
  const [search, setSearch] = useState("");
  const params = useMemo(
    () => ({ search: search.trim(), limit: 8 as const }),
    [search],
  );
  const enabled = search.trim().length >= 2;
  const q = useListPatients(params, {
    query: { enabled, queryKey: getListPatientsQueryKey(params) },
  });

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded border px-3 py-2 text-sm"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <span className="font-medium">
          {fullName(value.firstName, value.lastName)}
        </span>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => {
            onChange(null);
            setSearch("");
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const items = q.data?.items ?? [];
  return (
    <div>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search patient by name…"
        aria-label="Search patient"
        autoFocus
      />
      {enabled && (
        <div
          className="mt-1 max-h-56 overflow-y-auto rounded border"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {q.isFetching && items.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">Searching…</div>
          ) : items.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">
              No matching patients.
            </div>
          ) : (
            items.map((pt) => (
              <button
                key={pt.id}
                type="button"
                onClick={() =>
                  onChange({
                    id: pt.id,
                    firstName: pt.firstName,
                    lastName: pt.lastName,
                  })
                }
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium">
                  {fullName(pt.firstName, pt.lastName)}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {pt.pacwareId}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
