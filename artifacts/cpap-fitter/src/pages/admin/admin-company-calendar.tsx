// /admin/company-calendar — shared, staff-wide appointment calendar.
//
// Any signed-in team member can place patient appointments (virtual /
// in-person fittings & setups, follow-ups, consultations) on a month grid
// that the whole company sees. Distinct from /admin/appointment-requests
// (the inbound, patient-initiated triage queue) — these are the confirmed,
// scheduled events.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import {
  getListPatientsQueryKey,
  useListPatients,
} from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { fullName } from "@/lib/admin/format";
import {
  type CalendarEventType,
  type CompanyCalendarEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  listCompanyCalendar,
  updateCalendarEvent,
} from "@/lib/admin/company-calendar-api";

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

const MONTH_FMT = new Intl.DateTimeFormat([], {
  month: "long",
  year: "numeric",
});

type SelectedPatient = { id: string; firstName: string; lastName: string };

type EditorState =
  | { mode: "create"; date: Date }
  | { mode: "edit"; event: CompanyCalendarEvent };

// ── Page ─────────────────────────────────────────────────────────
export function AdminCompanyCalendarPage() {
  const [viewDate, setViewDate] = useState<Date>(() =>
    startOfMonth(new Date()),
  );
  const [editor, setEditor] = useState<EditorState | null>(null);

  const grid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const rangeFromIso = grid[0].toISOString();
  const rangeToIso = new Date(
    grid[41].getFullYear(),
    grid[41].getMonth(),
    grid[41].getDate() + 1,
  ).toISOString();

  const queryKey = [
    "admin",
    "company-calendar",
    viewDate.getFullYear(),
    viewDate.getMonth(),
  ] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listCompanyCalendar(rangeFromIso, rangeToIso),
  });

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CompanyCalendarEvent[]>();
    for (const ev of data?.events ?? []) {
      const k = dateKey(new Date(ev.startsAt));
      const arr = map.get(k);
      if (arr) arr.push(ev);
      else map.set(k, [ev]);
    }
    return map;
  }, [data]);

  const todayKey = dateKey(new Date());
  const viewMonth = viewDate.getMonth();

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
          team can see and edit it. Click any day to add an appointment.
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
            onClick={() =>
              setViewDate(new Date(viewDate.getFullYear(), viewMonth - 1, 1))
            }
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
            onClick={() =>
              setViewDate(new Date(viewDate.getFullYear(), viewMonth + 1, 1))
            }
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <Button
            intent="secondary"
            size="sm"
            onClick={() => setViewDate(startOfMonth(new Date()))}
          >
            Today
          </Button>
        </div>
        <Button onClick={() => setEditor({ mode: "create", date: new Date() })}>
          <Plus className="h-4 w-4 mr-1" />
          New appointment
        </Button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {EVENT_TYPE_ORDER.map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${EVENT_TYPE_META[t].dot}`}
            />
            {EVENT_TYPE_META[t].label}
          </span>
        ))}
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
                const dayEvents = eventsByDay.get(dateKey(day)) ?? [];
                return (
                  <div
                    key={dateKey(day)}
                    role="gridcell"
                    className={`group relative min-h-[6.5rem] border-b border-r p-1 ${
                      inMonth ? "bg-white" : "bg-slate-50/60"
                    }`}
                    style={{ borderColor: "hsl(var(--line-2))" }}
                  >
                    <button
                      type="button"
                      onClick={() => setEditor({ mode: "create", date: day })}
                      aria-label={`Add appointment on ${day.toLocaleDateString()}`}
                      className="flex w-full items-center justify-between rounded px-1 py-0.5 hover:bg-slate-100"
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
                      <Plus className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                    <div className="mt-1 space-y-1">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => setEditor({ mode: "edit", event: ev })}
                          title={`${timeLabel(ev.startsAt)} · ${
                            EVENT_TYPE_META[ev.eventType].label
                          } · ${fullName(
                            ev.patientFirstName,
                            ev.patientLastName,
                          )}`}
                          className={`block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px] ${
                            EVENT_TYPE_META[ev.eventType].chip
                          }`}
                        >
                          <span className="font-semibold">
                            {timeLabel(ev.startsAt)}
                          </span>{" "}
                          {fullName(ev.patientFirstName, ev.patientLastName)}
                        </button>
                      ))}
                      {dayEvents.length > 3 && (
                        <div className="px-1 text-[10px] text-muted-foreground">
                          +{dayEvents.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <UpcomingCard
        events={data?.events ?? []}
        isPending={isPending && !isError}
        onOpen={(ev) => setEditor({ mode: "edit", event: ev })}
      />

      {editor && <EventEditor state={editor} onClose={() => setEditor(null)} />}
    </div>
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
  const upcoming = events
    .filter((e) => new Date(e.endsAt).getTime() >= now)
    .slice(0, 12);
  return (
    <Card title="Upcoming appointments">
      {isPending ? (
        <Spinner />
      ) : upcoming.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
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
                  className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${EVENT_TYPE_META[ev.eventType].dot}`}
                />
                <span className="flex-1">
                  <span className="font-medium">
                    {fullName(ev.patientFirstName, ev.patientLastName)}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {EVENT_TYPE_META[ev.eventType].label}
                  </span>
                  {ev.location && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      {ev.location}
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
  onClose,
}: {
  state: EditorState;
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

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["admin", "company-calendar"] });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        patientId: patient!.id,
        eventType,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        location: location.trim() || null,
        notes: notes.trim() || null,
      };
      if (state.mode === "edit") {
        await updateCalendarEvent(state.event.id, body);
      } else {
        await createCalendarEvent(body);
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
