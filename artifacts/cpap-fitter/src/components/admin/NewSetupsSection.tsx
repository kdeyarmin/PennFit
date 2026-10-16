import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import { Button } from "@/components/admin/Button";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchSetupBoard,
  formatSetupAge,
  patchSetup,
  SETUP_STAGE_LABEL,
  type SetupBoardRow,
} from "@/lib/admin/setups-api";

const MORNING = [
  {
    key: "openReferralReviews" as const,
    label: "Open referral reviews",
    href: "/admin/referral-reviews",
  },
  {
    key: "staleFitRequests" as const,
    label: "Fit requests past one business day",
    href: "/admin/fitter-requests",
  },
  {
    key: "unsignedPackets" as const,
    label: "Packets unsigned more than two days",
    href: "/admin/patient-packets",
  },
  {
    key: "priorAuthsInSla" as const,
    label: "Prior auths still inside SLA",
    href: "/admin/billing/prior-auths",
  },
];

export function NewSetupsSection({ limit = 8 }: { limit?: number }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["admin", "setups", limit],
    queryFn: () => fetchSetupBoard(limit),
  });

  return (
    <section
      className="bg-white border rounded-lg p-5"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2
          className="text-base font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          New setups
        </h2>
        <Link href="/admin/setups" className="text-sm underline">
          Open the board
        </Link>
      </div>
      {isPending ? (
        <Spinner label="Loading setups…" />
      ) : isError ? (
        <p className="text-sm text-destructive">Could not load new setups.</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open setups.</p>
      ) : (
        <SetupTable rows={data.rows} canClaim={false} />
      )}
    </section>
  );
}

export function SetupTable({
  rows,
  canClaim,
}: {
  rows: SetupBoardRow[];
  canClaim: boolean;
}) {
  const queryClient = useQueryClient();
  const patch = useMutation({
    mutationFn: (input: {
      id: string;
      action: "claim" | "release" | "complete" | "cancel";
    }) => patchSetup(input.id, input.action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "setups"] });
    },
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Age</th>
            <th className="py-2 pr-3 font-medium">Patient</th>
            <th className="py-2 pr-3 font-medium">Stage</th>
            <th className="py-2 pr-3 font-medium">Blocker</th>
            <th className="py-2 pr-3 font-medium">Owner</th>
            {canClaim && <th className="py-2 font-medium"> </th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-t"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <td className="py-2 pr-3 whitespace-nowrap">
                {formatSetupAge(row.ageHours)}
              </td>
              <td className="py-2 pr-3">
                {row.patientId ? (
                  <Link
                    href={`/admin/patients/${row.patientId}?tab=setup`}
                    className="underline"
                  >
                    {row.displayName}
                  </Link>
                ) : (
                  row.displayName
                )}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                {SETUP_STAGE_LABEL[row.stage]}
              </td>
              <td className="py-2 pr-3">
                {row.blocker ? (
                  <Link href={row.href} className="underline">
                    {row.blocker}
                  </Link>
                ) : (
                  "None"
                )}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">
                {row.ownerEmail ?? "Unassigned"}
              </td>
              {canClaim && (
                <td className="py-2 whitespace-nowrap">
                  {row.kind === "setup" && (
                    <span className="inline-flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        intent="secondary"
                        disabled={patch.isPending}
                        onClick={() =>
                          patch.mutate({
                            id: row.id,
                            action: row.ownerEmail ? "release" : "claim",
                          })
                        }
                      >
                        {row.ownerEmail ? "Release" : "Claim"}
                      </Button>
                    </span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MorningQueueStrip({
  morning,
}: {
  morning: {
    openReferralReviews: number;
    staleFitRequests: number;
    unsignedPackets: number;
    priorAuthsInSla: number;
  };
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {MORNING.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className="block border rounded-lg p-3 hover:shadow-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div className="text-2xl font-semibold">{morning[item.key]}</div>
          <div className="text-xs text-muted-foreground mt-1">{item.label}</div>
        </Link>
      ))}
    </div>
  );
}
