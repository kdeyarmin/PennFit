// The evaluator's six states, and the three ways a threshold arrives.
//
// The property under test is not "does 5 exceed 3". It is that four
// different NON-alerting answers stay four different answers all the way
// to the panel: fine, off for this tenant, never configured, and could
// not be read. Every one of them has, in some system somewhere, been
// rendered as a healthy zero.

import { describe, expect, it } from "vitest";

import {
  evaluateSignal,
  formatSignalValue,
  isAlerting,
  compareForDisplay,
  resolveSignalThresholds,
  resolveThreshold,
  type SignalObservation,
} from "./evaluate";
import { findSignal, LIFECYCLE_SIGNALS } from "./signals";

const shippedUnbilled = findSignal("shipped_unbilled")!;
const denialRate = findSignal("payer_denial_rate")!;

const measured = (
  value: number,
  extra: Partial<SignalObservation> = {},
): SignalObservation => ({ state: "measured", value, ...extra });

describe("thresholds", () => {
  it("uses the catalog default when the variable is unset", () => {
    const t = resolveSignalThresholds(shippedUnbilled, {});
    expect(t.warn).toBe(shippedUnbilled.defaultWarn);
    expect(t.fail).toBe(shippedUnbilled.defaultFail);
    expect(t.source).toBe("default");
  });

  it("takes an override from the environment", () => {
    const t = resolveSignalThresholds(shippedUnbilled, {
      [shippedUnbilled.warnEnv]: "2",
      [shippedUnbilled.failEnv]: "7",
    });
    expect(t).toMatchObject({ warn: 2, fail: 7, source: "env" });
  });

  it("reports `env` when only ONE bound was overridden", () => {
    // The operator DID configure this signal. Calling it a default would
    // send them looking for a variable they had already set.
    const t = resolveSignalThresholds(shippedUnbilled, {
      [shippedUnbilled.failEnv]: "7",
    });
    expect(t.source).toBe("env");
    expect(t.warn).toBe(shippedUnbilled.defaultWarn);
  });

  it("falls back and SAYS SO on a malformed value", () => {
    // Neither throwing (which takes the monitor down over a typo) nor
    // going NaN (which makes every comparison false — a monitor that has
    // quietly stopped monitoring).
    const t = resolveSignalThresholds(shippedUnbilled, {
      [shippedUnbilled.warnEnv]: "not a number",
    });
    expect(t.warn).toBe(shippedUnbilled.defaultWarn);
    expect(t.source).toBe("default_after_invalid_env");
  });

  it.each(["", "   ", "-4", "NaN", "Infinity"])(
    "treats %o as unset or invalid, never as a threshold",
    (raw) => {
      const { value } = resolveThreshold({ X: raw }, "X", 12);
      expect(value).toBe(12);
    },
  );

  it("accepts a zero threshold, which means alert on anything", () => {
    const { value, source } = resolveThreshold({ X: "0" }, "X", 12);
    expect(value).toBe(0);
    expect(source).toBe("env");
  });
});

describe("the six states", () => {
  const env = {
    [shippedUnbilled.warnEnv]: "10",
    [shippedUnbilled.failEnv]: "50",
  };

  it("is ok inside the warn threshold", () => {
    expect(evaluateSignal(shippedUnbilled, measured(3), env).status).toBe("ok");
  });

  it("warns at the threshold, not past it", () => {
    expect(evaluateSignal(shippedUnbilled, measured(10), env).status).toBe(
      "warning",
    );
  });

  it("fails at the fail threshold", () => {
    expect(evaluateSignal(shippedUnbilled, measured(50), env).status).toBe(
      "failure",
    );
  });

  it("passes `disabled` through and drops the value", () => {
    // A disabled signal has no meaningful value, and carrying one
    // through invites a panel that prints last-known numbers under a
    // "not applicable" badge.
    const e = evaluateSignal(
      shippedUnbilled,
      { state: "disabled", value: 999, reason: "tenant does not bill" },
      env,
    );
    expect(e.status).toBe("disabled");
    expect(e.value).toBeNull();
    expect(e.reason).toBe("tenant does not bill");
  });

  it("passes `not_configured` through, distinctly from disabled", () => {
    const e = evaluateSignal(
      shippedUnbilled,
      { state: "not_configured", value: null, reason: "no feed" },
      env,
    );
    expect(e.status).toBe("not_configured");
  });

  it("reports `unknown` for a failed read — never zero", () => {
    const e = evaluateSignal(
      shippedUnbilled,
      { state: "unknown", value: null, reason: "read failed" },
      env,
    );
    expect(e.status).toBe("unknown");
    expect(e.value).toBeNull();
  });

  it("treats a `measured` observation with no value as unknown, not ok", () => {
    // A collector that claims to have measured and produced nothing is a
    // bug in the collector. Reporting `ok` would hide it forever.
    const e = evaluateSignal(
      shippedUnbilled,
      { state: "measured", value: null },
      env,
    );
    expect(e.status).toBe("unknown");
  });

  it.each([NaN, Infinity, -Infinity])(
    "treats %s as unknown rather than comparing it",
    (value) => {
      const e = evaluateSignal(shippedUnbilled, measured(value), env);
      expect(e.status).toBe("unknown");
    },
  );
});

describe("small populations do not breach", () => {
  it("withholds a ratio breach below the minimum sample", () => {
    // A 50% denial rate over two claims is one denial.
    const e = evaluateSignal(denialRate, measured(0.5, { sample: 2 }));
    expect(e.status).toBe("ok");
    expect(e.withheld).toBe("insufficient_sample");
    // The real number is still reported — the panel shows it next to the
    // reason rather than going blank.
    expect(e.value).toBe(0.5);
  });

  it("breaches once the population is large enough", () => {
    const e = evaluateSignal(
      denialRate,
      measured(0.5, { sample: denialRate.minSample! }),
    );
    expect(e.status).toBe("failure");
    expect(e.withheld).toBeNull();
  });

  it("does not withhold an OK reading", () => {
    const e = evaluateSignal(denialRate, measured(0.01, { sample: 2 }));
    expect(e.status).toBe("ok");
    expect(e.withheld).toBeNull();
  });

  it("never withholds a count signal, which has no minimum", () => {
    const e = evaluateSignal(shippedUnbilled, measured(999, { sample: 1 }));
    expect(e.status).toBe("failure");
    expect(e.withheld).toBeNull();
  });
});

describe("truncation travels with the value", () => {
  it("carries `truncated` through so the panel can call the number a floor", () => {
    const e = evaluateSignal(
      shippedUnbilled,
      measured(5000, { truncated: true }),
    );
    expect(e.truncated).toBe(true);
    expect(e.status).toBe("failure");
  });

  it("defaults to not truncated", () => {
    expect(evaluateSignal(shippedUnbilled, measured(1)).truncated).toBe(false);
  });
});

describe("display helpers", () => {
  it("formats each unit in its own terms", () => {
    expect(formatSignalValue(0.1234, "ratio")).toBe("12.3%");
    expect(formatSignalValue(3.21, "multiple")).toBe("3.2×");
    expect(formatSignalValue(12, "hours")).toBe("12.0h");
    expect(formatSignalValue(72, "hours")).toBe("3.0 days");
    expect(formatSignalValue(1234, "count")).toBe("1,234");
  });

  it("renders an absent value as a dash, never as zero", () => {
    expect(formatSignalValue(null, "count")).toBe("—");
    expect(formatSignalValue(NaN, "count")).toBe("—");
  });

  it("sorts failures first, then warnings, then unreadable, then quiet", () => {
    const rows = [
      { status: "ok" as const, severity: "critical" as const },
      { status: "disabled" as const, severity: "critical" as const },
      { status: "warning" as const, severity: "minor" as const },
      { status: "failure" as const, severity: "major" as const },
      { status: "unknown" as const, severity: "major" as const },
    ];
    expect([...rows].sort(compareForDisplay).map((r) => r.status)).toEqual([
      "failure",
      "warning",
      "unknown",
      "disabled",
      "ok",
    ]);
  });

  it("breaks ties on severity", () => {
    const rows = [
      { status: "failure" as const, severity: "minor" as const },
      { status: "failure" as const, severity: "critical" as const },
    ];
    expect([...rows].sort(compareForDisplay)[0].severity).toBe("critical");
  });

  it("counts only warning and failure as alerting", () => {
    expect(isAlerting("warning")).toBe(true);
    expect(isAlerting("failure")).toBe(true);
    for (const quiet of ["ok", "disabled", "not_configured", "unknown"] as const) {
      expect(isAlerting(quiet), quiet).toBe(false);
    }
  });
});

describe("every signal in the catalog evaluates", () => {
  it("produces a status for a measured zero without throwing", () => {
    for (const signal of LIFECYCLE_SIGNALS) {
      const e = evaluateSignal(signal, measured(0, { sample: 1000 }));
      expect(e.key, signal.key).toBe(signal.key);
      expect(["ok", "warning", "failure"], signal.key).toContain(e.status);
    }
  });

  it("produces `unknown` for every signal on a failed read", () => {
    for (const signal of LIFECYCLE_SIGNALS) {
      const e = evaluateSignal(signal, { state: "unknown", value: null });
      expect(e.status, signal.key).toBe("unknown");
    }
  });
});
