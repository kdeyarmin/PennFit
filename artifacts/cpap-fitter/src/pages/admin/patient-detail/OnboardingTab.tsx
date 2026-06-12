// Patient-detail "Onboarding" tab (Phase F.3 — Phase B.1 follow-up) —
// extracted from patient-detail.tsx.
//
// First-90-day adherence-coaching enrollment + per-day status.
// Renders three modes:
//   * Loading      — initial fetch.
//   * Not enrolled — single "Enroll" button. Defaults startedAt
//                    to NOW so the day-1 nudge fires tomorrow.
//   * Enrolled     — status pill + per-day timestamps + a
//                    Pause/Resume toggle.
//
// Helpers OnboardingJourneyView + OnboardingAttemptsView are scoped
// to this file.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { Button } from "@/components/admin/Button";
import { formatDate, formatDateTime } from "@/lib/admin/format";
import {
  enrollPatientOnboarding,
  fetchPatientOnboarding,
  fetchPatientOnboardingAttempts,
  setPatientOnboardingStatus,
  type OnboardingAttempt,
  type PatientOnboardingJourney,
} from "@/lib/admin/patient-onboarding-api";

export function OnboardingTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "patients", patientId, "onboarding"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => fetchPatientOnboarding(patientId),
  });

  const enrollMut = useMutation({
    mutationFn: () => enrollPatientOnboarding(patientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const statusMut = useMutation({
    mutationFn: (status: "active" | "paused") =>
      setPatientOnboardingStatus(patientId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (isPending) return <Spinner label="Loading onboarding…" />;
  if (isError) {
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }}>
        {error instanceof Error ? error.message : "Failed to load."}
      </p>
    );
  }

  if (!data.journey) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          This patient is not yet enrolled in the 90-day adherence program.
          Enrolling kicks off the day-1 / 7 / 30 / 90 SendGrid cadence; you can
          pause anytime.
        </p>
        {enrollMut.isError && (
          <p className="text-xs" style={{ color: "#b91c1c" }}>
            {enrollMut.error instanceof Error
              ? enrollMut.error.message
              : "Failed to enroll."}
          </p>
        )}
        <Button
          onClick={() => enrollMut.mutate()}
          isLoading={enrollMut.isPending}
          disabled={enrollMut.isPending}
          data-testid="patient-onboarding-enroll"
        >
          Enroll in 90-day program
        </Button>
      </div>
    );
  }

  const j = data.journey;
  return (
    <div className="space-y-4">
      <OnboardingJourneyView
        journey={j}
        onPauseToggle={(next) => statusMut.mutate(next)}
        toggling={statusMut.isPending}
        toggleError={
          statusMut.error instanceof Error ? statusMut.error.message : null
        }
      />
      <OnboardingAttemptsView patientId={patientId} />
    </div>
  );
}

function OnboardingJourneyView({
  journey,
  onPauseToggle,
  toggling,
  toggleError,
}: {
  journey: PatientOnboardingJourney;
  onPauseToggle: (status: "active" | "paused") => void;
  toggling: boolean;
  toggleError: string | null;
}) {
  const isActive = journey.status === "active";
  const canToggle = journey.status !== "completed";
  const days: Array<{
    label: string;
    sentAt: string | null;
    offsetDays: number;
  }> = [
    { label: "Day 1", sentAt: journey.day1SentAt, offsetDays: 1 },
    { label: "Day 3", sentAt: journey.day3SentAt, offsetDays: 3 },
    { label: "Day 7", sentAt: journey.day7SentAt, offsetDays: 7 },
    { label: "Day 30", sentAt: journey.day30SentAt, offsetDays: 30 },
    { label: "Day 60", sentAt: journey.day60SentAt, offsetDays: 60 },
    { label: "Day 90", sentAt: journey.day90SentAt, offsetDays: 90 },
  ];
  const startedMs = new Date(journey.startedAt).getTime();
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            journey.status === "completed"
              ? "success"
              : journey.status === "paused"
                ? "muted"
                : "info"
          }
        >
          {journey.status}
        </Badge>
        <span
          className="text-xs"
          style={{ color: "hsl(var(--ink-3))" }}
          data-testid="patient-onboarding-started-at"
        >
          Started {formatDateTime(journey.startedAt)} · enrolled by{" "}
          {journey.enrolledByEmail}
        </span>
      </div>

      <ul className="space-y-2" data-testid="patient-onboarding-day-list">
        {days.map((d) => {
          const dueAt = startedMs + d.offsetDays * 24 * 60 * 60 * 1000;
          const sent = d.sentAt !== null;
          const due = !sent && now >= dueAt;
          return (
            <li
              key={d.label}
              className="rounded border p-3 flex items-center gap-3"
              style={{
                borderColor: sent
                  ? "#bbf7d0"
                  : due
                    ? "#fecaca"
                    : "hsl(var(--line-1))",
                backgroundColor: sent ? "#f0fdf4" : due ? "#fef2f2" : "#ffffff",
              }}
            >
              <Badge variant={sent ? "success" : due ? "danger" : "muted"}>
                {sent ? "sent" : due ? "due" : "scheduled"}
              </Badge>
              <span
                className="text-sm font-semibold"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {d.label}
              </span>
              <span
                className="text-xs ml-auto"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {sent
                  ? `sent ${formatDateTime(d.sentAt!)}`
                  : `${due ? "due" : "scheduled for"} ${formatDate(new Date(dueAt).toISOString())}`}
              </span>
            </li>
          );
        })}
      </ul>

      {canToggle && (
        <div className="flex items-center gap-2">
          <Button
            intent="secondary"
            size="sm"
            onClick={() => onPauseToggle(isActive ? "paused" : "active")}
            isLoading={toggling}
            disabled={toggling}
            data-testid="patient-onboarding-toggle-status"
          >
            {isActive ? "Pause cadence" : "Resume cadence"}
          </Button>
          {toggleError && (
            <span className="text-xs" style={{ color: "#b91c1c" }}>
              {toggleError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Per-checkpoint dispatch attempts — shows "tried email, then SMS"
// trail so an admin can diagnose "why did Day 7 not actually
// reach this patient?"
function OnboardingAttemptsView({ patientId }: { patientId: string }) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: [
      "admin",
      "patients",
      patientId,
      "onboarding",
      "attempts",
    ] as const,
    queryFn: () => fetchPatientOnboardingAttempts(patientId),
  });
  if (isPending) return null;
  if (isError) {
    return (
      <p className="text-xs" style={{ color: "#b91c1c" }}>
        {error instanceof Error ? error.message : "Failed to load attempts."}
      </p>
    );
  }
  if (data.attempts.length === 0) return null;

  // Group by day_label so the trail reads "Day 7: email failed,
  // SMS sent." Newest attempts already first per server order.
  const grouped = new Map<string, OnboardingAttempt[]>();
  for (const a of data.attempts) {
    const list = grouped.get(a.dayLabel) ?? [];
    list.push(a);
    grouped.set(a.dayLabel, list);
  }
  const dayLabels = Array.from(grouped.keys());

  return (
    <div
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
      <div
        className="text-[10px] uppercase tracking-wider font-semibold mb-2"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        Dispatch trail
      </div>
      <ul className="space-y-2">
        {dayLabels.map((label) => (
          <li key={label}>
            <div
              className="text-xs font-semibold"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              {label}
            </div>
            <ul className="ml-3 text-[11px] space-y-0.5">
              {grouped.get(label)!.map((a) => (
                <li
                  key={a.id}
                  style={{
                    color:
                      a.outcome === "sent" ? "hsl(var(--ink-2))" : "#92400e",
                  }}
                >
                  <span className="font-mono">{a.channel}</span> ·{" "}
                  <span className="font-mono">{a.outcome}</span>
                  {a.errorCode && (
                    <span className="text-muted-foreground">
                      {" "}
                      ({a.errorCode})
                    </span>
                  )}
                  <span className="text-muted-foreground ml-2">
                    {formatDateTime(a.attemptedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
