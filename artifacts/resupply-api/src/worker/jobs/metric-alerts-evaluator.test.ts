import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { shiftDateUtc, buildAlertMessage } from "./metric-alerts-evaluator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "metric-alerts-evaluator.ts"),
  "utf8",
);

describe("shiftDateUtc", () => {
  it("subtracts 7 days across a month boundary", () => {
    expect(shiftDateUtc("2026-06-03", -7)).toBe("2026-05-27");
    expect(shiftDateUtc("2026-05-30", -7)).toBe("2026-05-23");
  });

  it("adds days as well", () => {
    expect(shiftDateUtc("2026-05-30", 7)).toBe("2026-06-06");
  });
});

describe("buildAlertMessage", () => {
  it("absolute mode formats cents", () => {
    const m = buildAlertMessage({
      metricKey: "revenue_net_cents",
      unit: "cents",
      mode: "absolute",
      comparison: "lt",
      thresholdValue: 100000,
      observedValue: 45000,
      comparedValue: 45000,
      baselineValue: null,
    });
    expect(m).toContain("revenue_net_cents is $450.00");
    expect(m).toContain("lt threshold $1000.00");
  });

  it("delta_7d mode shows the week-over-week move and both values", () => {
    const m = buildAlertMessage({
      metricKey: "denial_rate_pct",
      unit: "pct",
      mode: "delta_7d",
      comparison: "gt",
      thresholdValue: 5,
      observedValue: 12,
      comparedValue: 6,
      baselineValue: 6,
    });
    expect(m).toContain("moved 6.0% week-over-week");
    expect(m).toContain("now 12.0%, was 6.0%");
  });

  it("delta_pct_7d mode shows the percent change", () => {
    const m = buildAlertMessage({
      metricKey: "revenue_net_cents",
      unit: "cents",
      mode: "delta_pct_7d",
      comparison: "lt",
      thresholdValue: -15,
      observedValue: 8000,
      comparedValue: -20,
      baselineValue: 10000,
    });
    expect(m).toContain("changed -20.0% week-over-week");
    expect(m).toContain("now $80.00, was $100.00");
  });
});

// Source-pinned guard for the latest-snapshot batching (2026-06-05
// performance review §2 MEDIUM). The prior loop issued one ordered
// limit-1 read per threshold plus a per-threshold baseline read (N+1).
// Latest-per-key now comes from the metrics_daily_latest RPC (mig 0232)
// and the delta baselines come from a single bounded `.in()`.
describe("runMetricAlertsEvaluator — snapshot reads are batched", () => {
  it("uses the metrics_daily_latest RPC and reads latest from the map", () => {
    expect(SRC).toContain('.rpc("metrics_daily_latest"');
    expect(SRC).toContain("latestByKey.get(metricKey)");
  });

  it("does not re-introduce a per-threshold latest read inside the loop", () => {
    expect(SRC).not.toMatch(
      /\.from\("metrics_daily"\)\s*\.select\("metric_date, metric_value, unit"\)\s*\.eq\("metric_key", metricKey\)/,
    );
  });

  it("batches the delta-mode baselines in one .in() over key + date", () => {
    expect(SRC).toContain('.in("metric_key", Array.from(deltaKeys))');
    expect(SRC).toContain('.in("metric_date", Array.from(baselineDates))');
  });
});
