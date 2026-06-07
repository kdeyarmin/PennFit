// Voice-call metrics aggregator (powers /admin/voice/metrics).
//
// Pure: takes the rows pulled from resupply.voice_calls and reduces them
// to the operator-facing numbers — volume, answer rate, handle time
// (talk duration), and ring time (initiated -> answered). No DB, no
// clock; the route is the integration layer.

export interface VoiceCallRow {
  status: string | null;
  direction: string | null;
  durationSeconds: number | null;
  initiatedAt: string | null;
  answeredAt: string | null;
}

export interface VoiceMetricsResult {
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

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

export function aggregateVoiceMetrics(
  rows: VoiceCallRow[],
): VoiceMetricsResult {
  const byStatus: Record<string, number> = {};
  const byDirection = { inbound: 0, outbound: 0, other: 0 };
  const handleTimes: number[] = [];
  const ringTimes: number[] = [];
  let answeredCalls = 0;

  for (const r of rows) {
    const status = (r.status ?? "unknown").trim() || "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const dir = (r.direction ?? "").toLowerCase();
    if (dir.includes("inbound")) byDirection.inbound += 1;
    else if (dir.includes("outbound")) byDirection.outbound += 1;
    else byDirection.other += 1;

    if (r.answeredAt) answeredCalls += 1;

    if (typeof r.durationSeconds === "number" && r.durationSeconds > 0) {
      handleTimes.push(r.durationSeconds);
    }

    if (r.initiatedAt && r.answeredAt) {
      const ring =
        (new Date(r.answeredAt).getTime() - new Date(r.initiatedAt).getTime()) /
        1000;
      if (Number.isFinite(ring) && ring >= 0) ringTimes.push(ring);
    }
  }

  const totalCalls = rows.length;
  return {
    totalCalls,
    answeredCalls,
    answerRate: totalCalls === 0 ? null : round4(answeredCalls / totalCalls),
    byStatus,
    byDirection,
    avgHandleSeconds: mean(handleTimes),
    medianHandleSeconds: median(handleTimes),
    avgRingSeconds: mean(ringTimes),
    medianRingSeconds: median(ringTimes),
  };
}
