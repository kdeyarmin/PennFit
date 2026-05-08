// Phase 1 proof for the customer-message template library
// (docs/proposals/customer-message-templates.md).
//
// Pins the contract that lets future phases migrate dispatcher call
// sites one at a time without behavioural change: when the message-
// templates table is empty (or unreachable), renderMessage()'s
// fallback path must produce byte-for-byte the same string as the
// existing hard-coded sync renderer.
//
// If a future change to either the renderer string OR the
// substitution helper breaks that property, this test fires before
// any dispatcher gets migrated. The dispatchers themselves stay on
// the sync renderers in Phase 1 — Phase 2 wraps them.

import { describe, expect, it } from "vitest";

import {
  renderMessage,
  type TemplateLookup,
} from "@workspace/resupply-templates";

import {
  rxRenewalHtml,
  rxRenewalSms,
  rxRenewalSubject,
  rxRenewalText,
} from "./renderers";

const noTemplate: TemplateLookup = async () => null;

describe("rx-renewal renderers — template parity (Phase 1)", () => {
  // Two representative cases per renderer: a regular days-out value
  // and the "expires today" branch (daysUntilExpiry === 0). Both
  // shape the output meaningfully and would surface a substitution
  // / branching regression.
  const FIXTURES = [
    { greeting: "Hi Pat", firstName: "Pat", days: 7 },
    { greeting: "Hi Pat", firstName: "Pat", days: 0 },
    { greeting: "Hi Pat", firstName: "Pat", days: 1 },
  ];

  for (const { greeting, firstName, days } of FIXTURES) {
    it(`subject: fallback parity for daysUntilExpiry=${days}`, async () => {
      const expected = rxRenewalSubject(days);
      const result = await renderMessage(
        {
          templateKey: "rx_renewal.email",
          channel: "email",
          variables: {},
        },
        { subject: expected, bodyHtml: null, bodyText: expected },
        noTemplate,
      );
      expect(result.subject).toBe(expected);
    });

    it(`text body: fallback parity for daysUntilExpiry=${days}`, async () => {
      const expected = rxRenewalText(greeting, days);
      const result = await renderMessage(
        {
          templateKey: "rx_renewal.email",
          channel: "email",
          variables: {},
        },
        { subject: null, bodyHtml: null, bodyText: expected },
        noTemplate,
      );
      expect(result.bodyText).toBe(expected);
    });

    it(`html body: fallback parity for daysUntilExpiry=${days}`, async () => {
      const expected = rxRenewalHtml(greeting, days);
      const result = await renderMessage(
        {
          templateKey: "rx_renewal.email",
          channel: "email",
          variables: {},
        },
        { subject: null, bodyHtml: expected, bodyText: "" },
        noTemplate,
      );
      expect(result.bodyHtml).toBe(expected);
    });

    it(`sms body: fallback parity for daysUntilExpiry=${days}`, async () => {
      const expected = rxRenewalSms(firstName, days);
      const result = await renderMessage(
        {
          templateKey: "rx_renewal.sms",
          channel: "sms",
          variables: {},
        },
        { subject: null, bodyHtml: null, bodyText: expected },
        noTemplate,
      );
      expect(result.bodyText).toBe(expected);
    });
  }

  it("substitutes supplied variables in the fallback string too", async () => {
    // The fallback path applies substitution against the union of
    // variable names the caller supplied. If a future call site
    // refactors the sync renderer to emit `{{first_name}}` and
    // pass first_name in variables, the fallback path renders the
    // same way as the templated path. Pinning this lets Phase 2
    // safely migrate the renderers to placeholder-based fallbacks.
    const result = await renderMessage(
      {
        templateKey: "rx_renewal.sms",
        channel: "sms",
        variables: { first_name: "Pat" },
      },
      {
        subject: null,
        bodyHtml: null,
        bodyText: "Hi {{first_name}}, your Rx expires soon.",
      },
      noTemplate,
    );
    expect(result.bodyText).toBe("Hi Pat, your Rx expires soon.");
  });

  it("a degraded lookup (throws) lands on the fallback", async () => {
    const broken: TemplateLookup = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    const expected = rxRenewalSubject(7);
    const result = await renderMessage(
      {
        templateKey: "rx_renewal.email",
        channel: "email",
        variables: {},
      },
      { subject: expected, bodyHtml: null, bodyText: expected },
      broken,
    );
    expect(result.subject).toBe(expected);
  });
});
