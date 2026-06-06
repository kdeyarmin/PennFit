// Fetch wrapper for /admin/voice/metrics — voice-call timing metrics
// for the operations center. Cookie-authenticated, read-only.

import { ApiError } from "@workspace/api-client-react/admin";

export interface VoiceMetrics {
  windowDays: number;
  totalCalls: number;
  answeredCalls: number;
  answerRate: number | null;
  byStatus: Record<string, number>;
  byDirection: { inbound: number; outbound: number; other: number };
  avgHandleSeconds: number | null;
  medianHandleSeconds: number | null;
  avgRingSeconds: number | null;
  medianRingSeconds: number | null;
}

export async function fetchVoiceMetrics(days = 30): Promise<VoiceMetrics> {
  const url = `/resupply-api/admin/voice/metrics?days=${days}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as VoiceMetrics;
}
