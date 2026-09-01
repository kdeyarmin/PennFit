// The signal catalog as a CONTRACT.
//
// The panel's premise is that every row here is something an operator
// can read, believe and act on. That breaks in ways that are invisible
// from inside any single entry:
//
//   * a signal with no runbook, so the 2am page has no answer;
//   * a critical signal with no response procedure written down;
//   * a ratio with no minimum sample, which cries wolf on three claims;
//   * a threshold pair where the warning fires after the failure, which
//     makes the warning unreachable;
//   * a signal whose env-var names collide with another's, so tuning one
//     silently tunes the other.
//
// The runbook check is a real cross-artifact read of the shipped
// markdown, not a source grep: a critical alert whose procedure was
// renamed out from under it fails here rather than in front of the
// person answering the page.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findSignal,
  isWorkerOnly,
  LIFECYCLE_SIGNALS,
  PLATFORM_SIGNALS,
  TENANT_SIGNALS,
  WORKER_ONLY_SIGNAL_KEYS,
} from "./signals";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNBOOK = resolve(
  HERE,
  "../../../../../docs/runbooks/lifecycle-health-alerts.md",
);

/**
 * The shipped runbook, split into `#anchor -> body` the way GitHub would
 * generate the anchors. Reading the markdown itself means a renamed
 * heading fails here rather than in front of whoever is paged.
 */
function readRunbookSections(): Map<string, string> {
  const lines = readFileSync(RUNBOOK, "utf8").split("\n");
  const sections = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current) sections.set(current, body.join("\n"));
    body = [];
  };
  for (const line of lines) {
    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      current =
        "#" +
        heading[1]
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/**
 * Everything the assignment named, spelled as the catalog spells it.
 *
 * Pinned as a list rather than a count so dropping one and adding
 * another nets out visibly instead of silently.
 */
const REQUIRED_COVERAGE = [
  "cycle_creation_spike",
  "cycle_creation_stalled",
  "episodes_open_past_age",
  "never_contacted_growth",
  "no_response_growth",
  "assumed_shipped_growth",
  "address_hold_aging",
  "pacware_unmatched_rows",
  "pacware_ambiguous_rows",
  "pacware_invalid_dates",
  "shipment_evidence_lag",
  "fulfilled_not_shipped",
  "shipped_unbilled",
  "claims_stuck_submitting",
  "claims_missing_ship_evidence",
  "clearinghouse_rejection_rate",
  "payer_denial_rate",
  "connector_failures",
  "connector_partial_responses",
  "portal_reconciliation_discrepancies",
  "therapy_data_staleness",
  "voice_calls_unattributed",
  "inbound_attribution_failures",
  "flags_without_readiness_evidence",
  "approval_queues_past_sla",
  "worker_failures",
  "analytics_window_truncated",
] as const;

describe("coverage", () => {
  it("watches every signal the lifecycle review asked for", () => {
    const keys = new Set(LIFECYCLE_SIGNALS.map((s) => s.key));
    const missing = REQUIRED_COVERAGE.filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it("has a unique key per signal", () => {
    const keys = LIFECYCLE_SIGNALS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("splits cleanly into tenant and platform scope", () => {
    expect(TENANT_SIGNALS.length + PLATFORM_SIGNALS.length).toBe(
      LIFECYCLE_SIGNALS.length,
    );
    // The platform ones are about rows or resources that belong to NO
    // tenant. Repeating them inside every practice's panel would have
    // each operator chasing another's problem.
    expect(PLATFORM_SIGNALS.map((s) => s.key).sort()).toEqual([
      "inbound_attribution_failures",
      "voice_calls_unattributed",
      "worker_failures",
    ]);
  });

  it("keeps dead-letter depth OUT of tenant scope", () => {
    // pg-boss queues are process-wide: `getQueues()` reports one number
    // for the whole deployment and no dead job can be attributed back to
    // the tenant whose row it was working on. Evaluated per tenant, that
    // single number opened an identical alert in every practice's scope,
    // so one stuck job emailed N tenants about a queue none of them can
    // see or drain.
    expect(TENANT_SIGNALS.some((s) => s.key === "worker_failures")).toBe(false);
    expect(findSignal("worker_failures")?.scope).toBe("platform");
  });
});

describe("thresholds are usable", () => {
  it("orders warn before fail, so the warning is reachable", () => {
    for (const s of LIFECYCLE_SIGNALS) {
      expect(s.defaultWarn, s.key).toBeLessThanOrEqual(s.defaultFail);
    }
  });

  it("gives every signal a distinct pair of environment variables", () => {
    const names = LIFECYCLE_SIGNALS.flatMap((s) => [s.warnEnv, s.failEnv]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("derives the variable names from the key, so they are guessable", () => {
    const s = findSignal("shipped_unbilled")!;
    expect(s.warnEnv).toBe("LIFECYCLE_HEALTH_SHIPPED_UNBILLED_WARN");
    expect(s.failEnv).toBe("LIFECYCLE_HEALTH_SHIPPED_UNBILLED_FAIL");
  });

  it("requires a minimum sample on every ratio", () => {
    // A rate off three claims is not a rate.
    for (const s of LIFECYCLE_SIGNALS) {
      if (s.unit !== "ratio" && s.unit !== "multiple") continue;
      expect(s.minSample, s.key).toBeGreaterThan(0);
    }
  });

  it("keeps ratio thresholds inside 0..1, not as percentages", () => {
    // A `0.15` typed as `15` never fires. Nothing else in the catalog
    // would notice.
    for (const s of LIFECYCLE_SIGNALS) {
      if (s.unit !== "ratio") continue;
      expect(s.defaultFail, s.key).toBeLessThanOrEqual(1);
    }
  });

  it("does not put a minimum sample on a plain count", () => {
    for (const s of LIFECYCLE_SIGNALS) {
      if (s.unit === "ratio" || s.unit === "multiple") continue;
      expect(s.minSample, s.key).toBeUndefined();
    }
  });
});

describe("every signal is answerable", () => {
  it("explains itself at length", () => {
    // This is the argument that survives the next person asking "can we
    // turn this one off?". A one-liner is not that argument.
    for (const s of LIFECYCLE_SIGNALS) {
      expect(s.why.length, s.key).toBeGreaterThan(80);
    }
  });

  it("points at a page in the admin console", () => {
    for (const s of LIFECYCLE_SIGNALS) {
      expect(s.remedyHref, s.key).toMatch(/^\/admin/);
    }
  });

  it("names a runbook anchor", () => {
    for (const s of LIFECYCLE_SIGNALS) {
      expect(s.runbookAnchor, s.key).toMatch(/^#[a-z0-9-]+$/);
    }
  });

  it("has a real section in the shipped runbook for EVERY signal", () => {
    // Not a source grep: this reads the markdown that actually ships and
    // matches the heading anchors GitHub would generate. A renamed
    // heading fails here instead of in front of whoever is paged.
    const sections = readRunbookSections();
    const missing = LIFECYCLE_SIGNALS.filter(
      (s) => !sections.has(s.runbookAnchor),
    ).map((s) => `${s.key} -> ${s.runbookAnchor}`);
    expect(missing).toEqual([]);
  });

  it("gives every CRITICAL signal a response PROCEDURE, not just a heading", () => {
    // `critical` carries an obligation. A heading with two sentences
    // under it is a heading, and the person answering the page at 2am
    // needs steps.
    const sections = readRunbookSections();
    for (const s of LIFECYCLE_SIGNALS) {
      if (s.severity !== "critical") continue;
      const body = sections.get(s.runbookAnchor) ?? "";
      expect(body.length, `${s.key} has no runbook body`).toBeGreaterThan(400);
      // Steps, not prose. Numbered where the order matters, bulleted
      // where the procedure is a lookup keyed on the alert's own reason
      // (the attribution failures section is deliberately the second
      // shape — the four reasons need four different fixes and running
      // them in order would be wrong).
      const numbered = /^\s*1\./m.test(body);
      const bulleted = (body.match(/^\s*[-*]\s/gm) ?? []).length >= 3;
      expect(
        numbered || bulleted,
        `${s.key}: the runbook section is prose, not a procedure`,
      ).toBe(true);
    }
  });
});

describe("worker-only signals are declared", () => {
  it("names dead-letter depth, which needs a pg-boss handle", () => {
    expect(WORKER_ONLY_SIGNAL_KEYS).toEqual(["worker_failures"]);
    expect(isWorkerOnly("worker_failures")).toBe(true);
    expect(isWorkerOnly("shipped_unbilled")).toBe(false);
  });

  it("is a SEPARATE question from scope, even where the answers coincide", () => {
    // "who can take the reading" and "whose problem is it" are different
    // questions. They happen to give the same answer for the one signal
    // in this list today; collapsing them would silently present a stored
    // number as a live one the first time a worker-only TENANT signal is
    // added.
    for (const key of WORKER_ONLY_SIGNAL_KEYS) {
      expect(findSignal(key), key).toBeDefined();
    }
    expect(
      PLATFORM_SIGNALS.some((s) => !isWorkerOnly(s.key)),
      "a platform signal that is not worker-only must exist, or the two concepts have silently merged",
    ).toBe(true);
  });

  it("only names signals that exist in the catalog", () => {
    for (const key of WORKER_ONLY_SIGNAL_KEYS) {
      expect(findSignal(key), key).toBeDefined();
    }
  });
});

describe("severity", () => {
  it("reserves `critical` for signals where a person loses something", () => {
    // Not a value judgement in the abstract: `critical` carries the
    // obligation of a written procedure, so inflating it dilutes the
    // ones that matter.
    const critical = LIFECYCLE_SIGNALS.filter(
      (s) => s.severity === "critical",
    ).map((s) => s.key);
    for (const key of [
      "never_contacted_growth",
      "assumed_shipped_growth",
      "shipped_unbilled",
      "claims_missing_ship_evidence",
      "voice_calls_unattributed",
    ]) {
      expect(critical, key).toContain(key);
    }
  });

  it("does not make everything critical", () => {
    const critical = LIFECYCLE_SIGNALS.filter((s) => s.severity === "critical");
    expect(critical.length).toBeLessThan(LIFECYCLE_SIGNALS.length / 2);
  });
});

describe("findSignal", () => {
  it("finds by key", () => {
    expect(findSignal("payer_denial_rate")?.unit).toBe("ratio");
  });

  it("returns undefined rather than a default for an unknown key", () => {
    expect(findSignal("no_such_signal")).toBeUndefined();
  });
});
