import { describe, it, expect } from "vitest";

import { parseRecipientList, renderAlertDigest } from "./metric-alerts-notify";

describe("parseRecipientList", () => {
  it("splits, trims, lowercases, and drops non-emails", () => {
    expect(parseRecipientList(" Ops@penn.com , bad ,, biz@penn.com ")).toEqual([
      "ops@penn.com",
      "biz@penn.com",
    ]);
  });

  it("returns [] for undefined / empty", () => {
    expect(parseRecipientList(undefined)).toEqual([]);
    expect(parseRecipientList("")).toEqual([]);
  });
});

describe("renderAlertDigest", () => {
  const alerts = [
    {
      id: "a1",
      metricKey: "denial_rate_pct",
      severity: "warning",
      message: "denial_rate_pct moved 6.0% week-over-week.",
    },
    {
      id: "a2",
      metricKey: "revenue_net_cents",
      severity: "critical",
      message: "revenue_net_cents is $450.00.",
    },
  ];

  it("pluralizes the subject", () => {
    expect(renderAlertDigest(alerts).subject).toContain("2 metrics");
    expect(renderAlertDigest([alerts[0]!]).subject).toContain("1 metric ");
  });

  it("includes each message + severity in text and html", () => {
    const { text, html } = renderAlertDigest(alerts);
    expect(text).toContain("denial_rate_pct moved 6.0% week-over-week.");
    expect(text).toContain("[critical]");
    expect(html).toContain("revenue_net_cents is $450.00.");
    expect(text).toContain("/admin/metric-alerts");
  });

  it("escapes HTML in alert messages", () => {
    const { html } = renderAlertDigest([
      { id: "x", metricKey: "k", severity: "info", message: "a < b & c" },
    ]);
    expect(html).toContain("a &lt; b &amp; c");
  });
});
