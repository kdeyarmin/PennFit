// /admin/appointment-requests — CSR queue for patient-initiated
// appointment requests (fitting help, telehealth, billing question,
// general). Inbox-style table with state-change actions per row.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { useToast } from "@/hooks/use-toast";
import {
  listAppointmentRequests,
  updateAppointmentRequest,
  type AppointmentRequest,
  type AppointmentRequestStatus,
} from "@/lib/admin/appointment-requests-api";

const queryKey = (includeClosed: boolean) =>
  ["admin", "appointment-requests", { includeClosed }] as const;

const STATUS_LABELS: Record<AppointmentRequestStatus, string> = {
  new: "New",
  contacted: "Contacted",
  scheduled: "Scheduled",
  declined: "Declined",
  cancelled: "Cancelled",
};

export function AdminAppointmentRequestsPage() {
  const [includeClosed, setIncludeClosed] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKey(includeClosed),
    queryFn: () => listAppointmentRequests(includeClosed),
  });
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CalendarPlus className="h-6 w-6" />
            Appointment requests
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Patient-initiated requests for fitting help, telehealth, and general
            questions. New requests stay open until you mark them contacted,
            scheduled, or declined.
          </p>
        </div>
        <label className="text-xs flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          Show closed
        </label>
      </header>
      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.requests.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            {includeClosed
              ? "No appointment requests on file."
              : "No open requests — nice work."}
          </p>
        ) : (
          <RequestTable rows={data.requests} />
        )}
      </Card>
    </div>
  );
}

function RequestTable({ rows }: { rows: AppointmentRequest[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Requester</th>
          <th className="py-2 font-semibold">Topic</th>
          <th className="py-2 font-semibold">Preferred</th>
          <th className="py-2 font-semibold">Status</th>
          <th className="py-2 font-semibold" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <RequestRow key={r.id} row={r} />
        ))}
      </tbody>
    </table>
  );
}

function RequestRow({ row }: { row: AppointmentRequest }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const setStatus = useMutation({
    mutationFn: (status: AppointmentRequestStatus) =>
      updateAppointmentRequest(row.id, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["admin", "appointment-requests"],
      });
    },
    onError: (err) => {
      // Surface the failure so the CSR knows the row state didn't
      // change. Without this the button just settles back to idle
      // and they'd assume the action stuck.
      toast({
        title: "Couldn't update appointment request",
        description:
          err instanceof Error ? err.message : "Please try again in a moment.",
        variant: "destructive",
      });
    },
  });
  return (
    <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
      <td className="py-2 align-top">
        <div className="font-medium">
          {row.requesterName ?? row.requesterEmail}
        </div>
        <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {row.requesterEmail}
        </div>
        {row.requesterPhone && (
          <div className="text-xs font-mono">{row.requesterPhone}</div>
        )}
      </td>
      <td className="py-2 align-top">
        <div className="font-medium">{row.topic}</div>
        {row.notes && (
          <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {row.notes.slice(0, 120)}
            {row.notes.length > 120 ? "…" : ""}
          </div>
        )}
      </td>
      <td className="py-2 align-top text-xs">{row.preferredWindow ?? "—"}</td>
      <td className="py-2 align-top">
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider bg-blue-100 text-blue-900">
          {STATUS_LABELS[row.status]}
        </span>
      </td>
      <td className="py-2 align-top">
        <div className="flex gap-1 flex-wrap justify-end">
          {row.status === "new" && (
            <Button
              intent="ghost"
              onClick={() => setStatus.mutate("contacted")}
              disabled={setStatus.isPending}
            >
              Mark contacted
            </Button>
          )}
          {(row.status === "new" || row.status === "contacted") && (
            <>
              <Button
                intent="ghost"
                onClick={() => setStatus.mutate("scheduled")}
                disabled={setStatus.isPending}
              >
                Scheduled
              </Button>
              <Button
                intent="ghost"
                onClick={() => setStatus.mutate("declined")}
                disabled={setStatus.isPending}
              >
                Decline
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
