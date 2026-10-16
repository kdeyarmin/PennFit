import { useQuery } from "@tanstack/react-query";

import {
  MorningQueueStrip,
  SetupTable,
} from "@/components/admin/NewSetupsSection";
import { Spinner } from "@/components/admin/Spinner";
import { fetchSetupBoard } from "@/lib/admin/setups-api";

export function AdminSetupsPage() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["admin", "setups", 50],
    queryFn: () => fetchSetupBoard(50),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-display text-3xl font-bold tracking-tight">
          New setups
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One row from referral accept or a fit request until the first-night
          checklist is done. A signature does not finish the row. The patient
          does not place the order.
        </p>
      </div>
      {isPending ? (
        <Spinner label="Loading setups…" />
      ) : isError || !data ? (
        <div className="text-sm">
          <p className="text-destructive">Could not load the setup board.</p>
          <button
            type="button"
            className="underline mt-2"
            onClick={() => void refetch()}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <MorningQueueStrip morning={data.morning} />
          {data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open setups.</p>
          ) : (
            <SetupTable rows={data.rows} canClaim />
          )}
        </>
      )}
    </div>
  );
}
