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

/** Anything with a queue we could read and something in it, busiest
 *  first; then the gates with nothing waiting, so the panel still
 *  documents the full set without burying what needs doing. */
function order(gates: ApprovalGateRow[]): ApprovalGateRow[] {
  return [...gates].sort((a, b) => (b.waiting ?? -1) - (a.waiting ?? -1));
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
        until someone decides.
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
                    : gate.countable
                      ? "Could not read this queue just now — the number is unknown, not zero"
                      : "No single queue to count for this step"
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
