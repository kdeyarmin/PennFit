// Thin typed client for the /admin/nps/* endpoints.

import { ApiError } from "@workspace/api-client-react/admin";

export interface NpsRecentResponse {
  windowDays: number;
  total: number;
  counts: {
    promoter: number;
    passive: number;
    detractor: number;
  };
  /** Canonical NPS score (% promoter − % detractor), or null when no responses. */
  npsScore: number | null;
  comments: Array<{
    id: string;
    orderId: string;
    score: number;
    comment: string | null;
    createdAt: string;
  }>;
}

export async function fetchRecentNps(
  opts: {
    days?: number;
    commentLimit?: number;
  } = {},
): Promise<NpsRecentResponse> {
  const params = new URLSearchParams();
  if (opts.days != null) params.set("days", String(opts.days));
  if (opts.commentLimit != null) {
    params.set("commentLimit", String(opts.commentLimit));
  }
  const qs = params.toString();
  const url = `/resupply-api/admin/nps/recent${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as NpsRecentResponse;
}
