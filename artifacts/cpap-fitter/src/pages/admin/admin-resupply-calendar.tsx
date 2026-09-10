import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PatientSupplyOverview } from "@/components/admin/PatientSupplyOverview";
import { ResupplyOutreachActions } from "@/components/admin/ResupplyOutreachActions";
import {
  getResupplyCalendar,
  groupResupplyPatients,
  localDayKey,
} from "@/lib/admin/resupply-calendar-api";
import { formatDate } from "@/lib/admin/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function AdminResupplyCalendarPage() {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [mode, setMode] = useState<"month" | "due">("month");
  const [day, setDay] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(
    null,
  );
  const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const from =
    mode === "month" ? month.toISOString() : new Date().toISOString();
  const to =
    mode === "month"
      ? nextMonth.toISOString()
      : new Date(Date.now() + 86400000).toISOString();
  // A date-stable key prevents a request loop in the due-now view.
  const query = useQuery({
    queryKey: [
      "admin",
      "resupply-calendar",
      mode,
      localDayKey(month),
      localDayKey(new Date()),
    ],
    queryFn: () => getResupplyCalendar(from, to, mode === "due"),
    refetchOnWindowFocus: true,
  });
  const items = query.data?.items ?? [];
  const visible = items.filter(
    (i) =>
      (!day || mode !== "month" || localDayKey(i.dueAt) === day) &&
      `${i.patientName} ${i.itemSku}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
  );
  const groups = groupResupplyPatients(visible);
  const recipients = groups
    .filter((g) => selected.has(g[0]!.patientId))
    .map((g) => ({ id: g[0]!.id, patientName: g[0]!.patientName }));
  const monthLabel = month.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  function moveMonth(delta: number) {
    setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
    setDay(null);
    setSelected(new Set());
    setMode("month");
  }
  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < 50) next.add(id);
      return next;
    });
  }
  return (
    <div className="admin-root p-4 md:p-6 space-y-5 max-w-7xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CalendarDays /> Resupply calendar
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            See who is due, review what they ordered, and ask whether they need
            supplies.
          </p>
        </div>
        <Link className="text-sm underline" href="/admin/episodes">
          View resupply episodes
        </Link>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button
          intent={mode === "month" ? "primary" : "secondary"}
          onClick={() => {
            setMode("month");
            setDay(null);
            setSelected(new Set());
          }}
        >
          Month calendar
        </Button>
        <Button
          intent={mode === "due" ? "primary" : "secondary"}
          onClick={() => {
            setMode("due");
            setDay(null);
            setSelected(new Set());
          }}
        >
          Due now & overdue
        </Button>
      </div>
      {mode === "month" && (
        <Card>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">{monthLabel}</h2>
            <div className="flex items-center gap-2">
              <Button
                intent="secondary"
                size="sm"
                aria-label="Previous month"
                onClick={() => moveMonth(-1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                intent="secondary"
                size="sm"
                onClick={() => {
                  setMonth(
                    new Date(
                      new Date().getFullYear(),
                      new Date().getMonth(),
                      1,
                    ),
                  );
                  setDay(null);
                  setSelected(new Set());
                }}
              >
                Today
              </Button>
              <Button
                intent="secondary"
                size="sm"
                aria-label="Next month"
                onClick={() => moveMonth(1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="text-xs text-muted-foreground py-2">
                {d}
              </div>
            ))}
            {Array.from({ length: month.getDay() }, (_, i) => (
              <div key={`blank-${i}`} />
            ))}
            {Array.from(
              {
                length: new Date(
                  month.getFullYear(),
                  month.getMonth() + 1,
                  0,
                ).getDate(),
              },
              (_, i) => {
                const date = new Date(
                  month.getFullYear(),
                  month.getMonth(),
                  i + 1,
                );
                const key = localDayKey(date);
                const count = new Set(
                  items
                    .filter((row) => localDayKey(row.dueAt) === key)
                    .map((row) => row.patientId),
                ).size;
                return (
                  <button
                    key={key}
                    aria-label={`${date.toLocaleDateString()}, ${count} patients due`}
                    aria-pressed={day === key}
                    onClick={() => {
                      setDay(day === key ? null : key);
                      setSelected(new Set());
                    }}
                    className={`min-h-20 rounded border p-1 sm:p-3 text-left transition-colors ${day === key ? "bg-primary text-primary-foreground" : count ? "bg-accent" : "bg-background"}`}
                  >
                    <span
                      className={
                        key === localDayKey(new Date())
                          ? "font-bold underline"
                          : "font-medium"
                      }
                    >
                      {i + 1}
                    </span>
                    {count > 0 && (
                      <span className="block text-xs mt-2">
                        {count}{" "}
                        <span className="hidden sm:inline">
                          patient{count === 1 ? "" : "s"}
                        </span>
                      </span>
                    )}
                  </button>
                );
              },
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Dates follow scheduled resupply episodes and your browser's
            timezone. Open a patient to check replacement eligibility and order
            history. Calendar dates alone do not confirm insurance coverage.
          </p>
        </Card>
      )}
      <Card
        title={
          mode === "due"
            ? "Due now & overdue"
            : day
              ? `Patients due ${day}`
              : `Patients due in ${monthLabel}`
        }
      >
        <div className="flex flex-wrap gap-3 items-center mb-4">
          <input
            aria-label="Search resupply patients or supplies"
            placeholder="Search patients or supplies…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected(new Set());
            }}
            className="rounded border px-3 py-2 text-sm bg-background"
          />
          {day && (
            <Button
              size="sm"
              intent="secondary"
              onClick={() => {
                setDay(null);
                setSelected(new Set());
              }}
            >
              Show whole month
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            {groups.length} patients · {visible.length} supply cycles
          </span>
        </div>
        {query.isPending ? (
          <Spinner label="Loading resupply calendar…" />
        ) : query.isError ? (
          <ErrorPanel
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <div className="border rounded p-3 mb-4 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Select visible patients"
                  checked={
                    groups.length > 0 &&
                    groups
                      .slice(0, 50)
                      .every((g) => selected.has(g[0]!.patientId))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Set(
                            groups.slice(0, 50).map((g) => g[0]!.patientId),
                          )
                        : new Set(),
                    )
                  }
                />{" "}
                Select visible patients (up to 50)
              </label>
              <ResupplyOutreachActions
                key={`${mode}-${localDayKey(month)}-${day ?? "all"}-${search}`}
                recipients={recipients}
              />
            </div>
            {!groups.length ? (
              <p className="py-6 text-sm text-muted-foreground">
                No active patients with scheduled resupply in this view.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      {[
                        "Select",
                        "Patient",
                        "Supplies / due date",
                        "Contact",
                        "Review",
                      ].map((h) => (
                        <th key={h} className="p-3">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const first = group[0]!;
                      return (
                        <tr
                          key={first.patientId}
                          className="border-b align-top"
                        >
                          <td className="p-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${first.patientName}`}
                              checked={selected.has(first.patientId)}
                              disabled={
                                !selected.has(first.patientId) &&
                                selected.size >= 50
                              }
                              onChange={() => toggle(first.patientId)}
                            />
                          </td>
                          <td className="p-3">
                            <Link
                              href={`/admin/patients/${first.patientId}?tab=resupply`}
                              className="font-semibold underline"
                            >
                              {first.patientName}
                            </Link>
                            <p className="text-xs text-muted-foreground mt-1">
                              {first.status === "awaiting_response"
                                ? "Awaiting reply"
                                : "Outreach pending"}
                            </p>
                          </td>
                          <td className="p-3">
                            {group.map((i) => (
                              <p key={i.id}>
                                {i.itemSku}{" "}
                                <span className="text-muted-foreground">
                                  · {formatDate(i.dueAt)}
                                </span>
                              </p>
                            ))}
                          </td>
                          <td className="p-3">
                            <p>
                              {first.hasEmail ? "Email on file" : "No email"}
                            </p>
                            <p>
                              {first.hasPhone ? "Phone on file" : "No phone"}
                            </p>
                            {first.channelPreference && (
                              <p className="text-xs text-muted-foreground">
                                Prefers {first.channelPreference}
                              </p>
                            )}
                          </td>
                          <td className="p-3">
                            <Button
                              intent="secondary"
                              size="sm"
                              onClick={() => {
                                setPatient({
                                  id: first.patientId,
                                  name: first.patientName,
                                });
                                setSelected(new Set([first.patientId]));
                              }}
                            >
                              Orders & eligibility
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
      {patient && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPatient(null);
          }}
        >
          <DialogContent className="admin-root sm:max-w-6xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{patient.name}</DialogTitle>
              <DialogDescription>
                Review orders and replacement eligibility before requesting
                supplies.
              </DialogDescription>
            </DialogHeader>
            <PatientSupplyOverview
              key={patient.id}
              patientId={patient.id}
              patientName={patient.name}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
