// Hand-rolled fetch wrapper for the subscription metrics endpoint.

type ClerkGlobal = {
  session?: { getToken: () => Promise<string | null> } | null;
};

async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (globalThis as unknown as { Clerk?: ClerkGlobal }).Clerk;
  if (!clerk?.session) return {};
  try {
    const token = await clerk.session.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export interface SubsMetrics {
  counters: {
    activeNow: number;
    pausedNow: number;
    pastDueNow: number;
    canceledLifetime: number;
    newSubsLast30d: number;
    newSubsLast90d: number;
    canceledLast30d: number;
    canceledLast90d: number;
    pendingCancellations: number;
  } | null;
  churnRate30d: number;
  cohort: Array<{
    cohortMonth: string;
    totalCreated: number;
    stillLive: number;
  }>;
}

export async function fetchSubsMetrics(): Promise<SubsMetrics> {
  const res = await fetch(
    "/resupply-api/admin/shop/subscriptions/metrics",
    {
      headers: { Accept: "application/json", ...(await authHeaders()) },
    },
  );
  if (!res.ok) throw new Error(`Failed to load metrics (${res.status})`);
  return (await res.json()) as SubsMetrics;
}
