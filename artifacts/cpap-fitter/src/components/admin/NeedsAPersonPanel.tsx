// "Needs a person" — every transition in the platform that will not move
// on its own, with how many are waiting.
//
// The posture behind these gates is deliberate and stated in the code at
// each site, but it was stated in about a dozen places and nowhere as a
// set. So an operator could not see what was waiting on THEM without
// opening a dozen queues and knowing which ones existed — and the ones
// they did not know about simply grew.
//
// Each row says WHY a person is required, because that is the question
// this panel provokes and the honest answer is usually short.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { UserCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchApprovalGates,
  type ApprovalGateRow,
} from "@/lib/admin/approval-gates-api";

/**
 * What is LATE first, then what is busiest.
 *
 * A count alone sorts fifty items that arrived this morning above five
 * that have sat for six weeks, and only the second group is failing
 * anybody. So a breached queue outranks a merely large one, and within
 * each band the deeper queue comes first. Gates with nothing waiting
 * stay listed at the bottom, so the panel still documents the full set
 * without burying what needs doing.
 */
const AGE_RANK: Record<string, number> = {
  escalate: 0,
  breached: 1,
  due_soon: 2,
  unknown: 3,
  ok: 4,
  no_sla: 5,
};

function order(gates: ApprovalGateRow[]): ApprovalGateRow[] {
  return [...gates].sort((a, b) => {
    const byAge = (AGE_RANK[a.ageStatus] ?? 9) - (AGE_RANK[b.ageStatus] ?? 9);
    if (byAge !== 0) return byAge;
    return (b.waiting ?? -1) - (a.waiting ?? -1);
  });
}

/** How long the oldest item has waited, in words. */
function waitedFor(hours: number | null): string {
  if (hours === null) return "";
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function NeedsAPersonPanel() {
  const query = useQuery({
    queryKey: ["admin", "approval-gates"],
    queryFn: fetchApprovalGates,
    staleTime: 60_000,
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2 font-semibold">
          <UserCheck className="h-4 w-4" /> Needs a person
        </span>
      }
    >
      <p className="text-xs mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        These steps do not happen on their own — by design. Nothing below moves
        until someone decides, except where a row says otherwise.
      </p>

      {query.isPending && <Spinner />}
      {query.error && <ErrorPanel error={query.error} />}

      {query.data && (
        <ul className="space-y-2">
          {order(query.data.gates).map((gate) => (
            <li
              key={gate.key}
              className="flex items-start justify-between gap-3 border-t pt-2 first:border-t-0 first:pt-0"
            >
              <div className="min-w-0">
                <Link
                  href={gate.href}
                  className="text-sm font-medium hover:underline"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  {gate.label}
                </Link>
                <p
                  className="text-xs mt-0.5"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {gate.actorLabel} — {gate.why}
                </p>
                {(gate.ageStatus === "breached" ||
                  gate.ageStatus === "escalate") && (
                  // The half a count cannot show. `escalate` is past the
                  // SLA by the configured multiple: past the SLA is
                  // late, past the multiple is nobody is working this,
                  // and those want different responses.
                  <p
                    className="text-xs mt-0.5 font-medium"
                    style={{
                      color:
                        gate.ageStatus === "escalate" ? "#991b1b" : "#92400e",
                    }}
                  >
                    Oldest has waited {waitedFor(gate.oldestAgeHours)} —{" "}
                    {gate.ageStatus === "escalate" ? "well past" : "past"} the{" "}
                    {gate.slaHours}h expectation for this queue.
                  </p>
                )}
                {gate.ageStatus === "due_soon" && (
                  <p
                    className="text-xs mt-0.5"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    Oldest has waited {waitedFor(gate.oldestAgeHours)}, due
                    within {gate.slaHours}h.
                  </p>
                )}
                {gate.partlyAutomated && (
                  // Without this the count reads as a backlog when part of
                  // it will clear on its own, and an operator who opens the
                  // queue and finds it already handled stops believing the
                  // rest of the panel.
                  <p
                    className="text-xs mt-0.5 italic"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    Automated submission is on for this practice, so some of
                    these will clear without you. This count is an upper bound.
                  </p>
                )}
              </div>
              <span
                className="text-sm font-semibold whitespace-nowrap"
                style={{
                  color:
                    gate.waiting && gate.waiting > 0
                      ? "#991b1b"
                      : "hsl(var(--ink-3))",
                }}
                // Both cases show a dash — "nothing waiting" and "we
                // could not find out" must not render as the same zero —
                // but they are not the same dash, and only the second one
                // is a reason to come back later.
                title={
                  gate.waiting !== null
                    ? undefined
                    : gate.countFailed
                      ? "Could not read this queue just now — the number is unknown, not zero"
                      : (gate.uncountableReason ??
                        "No single queue to count for this step")
                }
              >
                {gate.waiting === null ? "—" : gate.waiting.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
