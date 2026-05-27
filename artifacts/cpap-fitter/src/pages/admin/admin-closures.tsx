// /admin/closures — manage office-closure windows.
//
// During a window's active range, the inbound SMS handler emits
// the configured auto-reply for any non-STOP/HELP inbound. This
// page is where CSRs declare those windows (federal holidays,
// snow days, all-hands offsites).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Plus } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  createClosure,
  endClosureNow,
  getActiveClosure,
  listOfficeClosures,
  type OfficeClosure,
} from "@/lib/admin/office-closures-api";

export function AdminClosuresPage() {
  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CalendarOff className="h-6 w-6" />
          Office closures
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Schedule closure windows (federal holidays, weather, offsites).
          During an active window, inbound SMS gets the auto-reply you set
          here; the normal conversation dispatcher is bypassed for that
          inbound. STOP / HELP are always honored.
        </p>
      </header>

      <ActiveClosureBanner />
      <NewClosureCard />
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
        From {new Date(c.startsAt).toLocaleString()} → {" "}
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
            onChange={(e) =>
              setAutoReplyMessage(e.target.value.slice(0, 320))
            }
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
  const state =
    end <= now ? "past" : start <= now ? "active" : "upcoming";
  return (
    <tr
      className="border-b"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
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
