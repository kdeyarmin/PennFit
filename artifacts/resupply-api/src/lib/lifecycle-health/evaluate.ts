// Turn an observation into a status. Pure — no clock, no environment
// read except the one passed in, no I/O.
//
// SIX STATES, NOT TWO
// -------------------
// "Fine", "getting bad", "bad", "this tenant does not do this", "nobody
// configured it" and "we could not find out" are six different answers,
// and four of them look like `ok` if you let them. Every one of the four
// has produced a real outage that a dashboard reported as healthy:
//
//   ok              inside threshold, and we actually measured it
//   warning         past the warn threshold
//   failure         past the fail threshold
//   disabled        this tenant does not use the feature the signal
//                   watches. There is nothing to measure and nothing
//                   wrong. (A tenant with no shipment feed has no
//                   shipment-evidence lag.)
//   not_configured  the feature EXISTS but nothing has been set up, so
//                   the true value is unknown and reporting zero would
//                   be a claim we cannot support. (No reconciliation has
//                   ever been run, so there are no discrepancies — and
//                   also no evidence that there are none.)
//   unknown         the read failed. An outage in the monitor, not a
//                   quiet day in the business.
//
// `unknown` never resolves an open alert. A read that failed is not
// evidence that a problem went away, and letting it close alerts means
// a database hiccup silently clears the board.
//
// SMALL SAMPLES DO NOT BREACH
// ---------------------------
// A 50% denial rate over two claims is one denial. Ratio signals declare
// a `minSample`; below it the evaluation reports `ok` and says WHY it
// withheld, so the panel can show the real ratio next to "too few claims
// to judge" instead of either crying wolf or going blank.

import type { LifecycleSignal } from "./signals";

export type SignalStatus =
  | "ok"
  | "warning"
  | "failure"
  | "disabled"
  | "not_configured"
  | "unknown";

/** What a collector produces for one signal. */
export interface SignalObservation {
  /**
   * `measured` means `value` is a real number we stand behind. Anything
   * else means `value` is meaningless and must not be rendered.
   */
  state: "measured" | "disabled" | "not_configured" | "unknown";
  value: number | null;
  /** Denominator behind a ratio, or population behind a rate. */
  sample?: number | null;
  /**
   * Bounded, PHI-free context — counts and vocabulary strings only.
   * Rendered on the panel and included in the alert body, so it is
   * subject to exactly the same rule as a log line.
   */
  detail?: Record<string, number | string | boolean | null>;
  /** Why the state is not `measured`. Shown to the operator verbatim. */
  reason?: string;
  /**
   * True when the collector hit a row cap, so `value` is a FLOOR rather
   * than a total. Feeds the `analytics_window_truncated` meta-signal and
   * is surfaced beside the number, because an understated backlog that
   * looks precise is worse than one that admits it is partial.
   */
  truncated?: boolean;
}

export type ThresholdSource = "default" | "env" | "default_after_invalid_env";

export interface SignalEvaluation {
  key: string;
  status: SignalStatus;
  value: number | null;
  sample: number | null;
  warnThreshold: number;
  failThreshold: number;
  thresholdSource: ThresholdSource;
  /**
   * Set when a threshold WAS crossed but the result was held back —
   * today only for an under-sized ratio population. The panel shows the
   * value and the reason; nobody is paged.
   */
  withheld: "insufficient_sample" | null;
  reason: string | null;
  truncated: boolean;
  detail: Record<string, number | string | boolean | null>;
}

/**
 * Read one threshold from the environment.
 *
 * A malformed value falls back to the default and SAYS so, rather than
 * either throwing (which would take the monitor down over a typo) or
 * silently becoming NaN (which makes every comparison false, i.e. a
 * monitor that has quietly stopped monitoring).
 */
export function resolveThreshold(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): { value: number; source: ThresholdSource } {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return { value: fallback, source: "default" };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: fallback, source: "default_after_invalid_env" };
  }
  return { value: parsed, source: "env" };
}

export interface ResolvedThresholds {
  warn: number;
  fail: number;
  source: ThresholdSource;
}

/**
 * Both bounds for one signal.
 *
 * When only one of the pair is overridden the source reports `env` — the
 * operator did configure this signal, and calling it `default` would
 * send them looking for a variable they already set. When either is
 * malformed the whole pair reports `default_after_invalid_env`, because
 * a half-applied threshold is the case worth surfacing.
 */
export function resolveSignalThresholds(
  signal: LifecycleSignal,
  env: NodeJS.ProcessEnv,
): ResolvedThresholds {
  const warn = resolveThreshold(env, signal.warnEnv, signal.defaultWarn);
  const fail = resolveThreshold(env, signal.failEnv, signal.defaultFail);
  const source: ThresholdSource =
    warn.source === "default_after_invalid_env" ||
    fail.source === "default_after_invalid_env"
      ? "default_after_invalid_env"
      : warn.source === "env" || fail.source === "env"
        ? "env"
        : "default";
  return { warn: warn.value, fail: fail.value, source };
}

export function evaluateSignal(
  signal: LifecycleSignal,
  observation: SignalObservation,
  env: NodeJS.ProcessEnv = process.env,
): SignalEvaluation {
  const thresholds = resolveSignalThresholds(signal, env);
  const base = {
    key: signal.key,
    sample: observation.sample ?? null,
    warnThreshold: thresholds.warn,
    failThreshold: thresholds.fail,
    thresholdSource: thresholds.source,
    withheld: null,
    truncated: observation.truncated === true,
    detail: observation.detail ?? {},
  } as const;

  if (observation.state !== "measured") {
    return {
      ...base,
      status: observation.state,
      // A non-measured state has no value worth rendering, and carrying
      // one through invites a panel that prints last-known numbers under
      // a "not configured" badge.
      value: null,
      reason: observation.reason ?? null,
    };
  }

  const value = observation.value;
  if (value === null || !Number.isFinite(value)) {
    // A collector that said "measured" and produced nothing is a bug in
    // the collector, not a healthy signal. Report the outage.
    return {
      ...base,
      status: "unknown",
      value: null,
      reason: observation.reason ?? "collector returned no value",
    };
  }

  const breached =
    value >= thresholds.fail
      ? "failure"
      : value >= thresholds.warn
        ? "warning"
        : "ok";

  if (breached !== "ok" && signal.minSample !== undefined) {
    const sample = observation.sample ?? 0;
    if (sample < signal.minSample) {
      return {
        ...base,
        status: "ok",
        value,
        withheld: "insufficient_sample",
        reason: `Held back: ${sample} in the population, ${signal.minSample} needed before this ratio means anything.`,
      };
    }
  }

  return {
    ...base,
    status: breached,
    value,
    reason: observation.reason ?? null,
  };
}

/** Order for display and for the digest: worst first, then by severity. */
const STATUS_RANK: Record<SignalStatus, number> = {
  failure: 0,
  warning: 1,
  unknown: 2,
  not_configured: 3,
  disabled: 4,
  ok: 5,
};

const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 } as const;

export function compareForDisplay(
  a: { status: SignalStatus; severity: keyof typeof SEVERITY_RANK },
  b: { status: SignalStatus; severity: keyof typeof SEVERITY_RANK },
): number {
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus;
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

/** Statuses that represent something actually wrong right now. */
export function isAlerting(status: SignalStatus): boolean {
  return status === "warning" || status === "failure";
}

/**
 * Format a value for a human, given its unit.
 *
 * Exported and pure so the digest email, the Slack line and the panel
 * cannot drift into three different renderings of the same number.
 */
export function formatSignalValue(
  value: number | null,
  unit: LifecycleSignal["unit"],
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "multiple":
      return `${value.toFixed(1)}×`;
    case "hours":
      return value >= 48
        ? `${(value / 24).toFixed(1)} days`
        : `${value.toFixed(1)}h`;
    case "days":
      return `${value.toFixed(1)} days`;
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}
