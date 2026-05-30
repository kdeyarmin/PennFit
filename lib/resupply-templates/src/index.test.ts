// Unit tests for the render-path primitives. Cover the four
// behaviours that matter in production:
//
//   1. Variable substitution respects the per-template allowlist
//      (typo'd variables stay literal, unknown variables stay literal).
//   2. The fallback path substitutes too (a DB miss never ships
//      raw `{{var}}` syntax to a customer).
//   3. The lookup is cached across calls inside the TTL window.
//   4. Lookup failures are degraded-to-fallback, not propagated.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetTemplateCacheForTests,
  applyVariables,
  type MessageTemplate,
  renderMessage,
  type TemplateLookup,
} from "./index";

afterEach(() => {
  __resetTemplateCacheForTests();
  vi.useRealTimers();
});

describe("applyVariables", () => {
  it("substitutes allowed + supplied variables", () => {
    expect(
      applyVariables(
        "Hi {{first_name}}, your order #{{order_ref}} shipped.",
        { first_name: "Pat", order_ref: "PENN-ABC123" },
        ["first_name", "order_ref"],
      ),
    ).toBe("Hi Pat, your order #PENN-ABC123 shipped.");
  });

  it("leaves an unknown variable name literal so a typo is visible", () => {
    expect(
      applyVariables("Hi {{first_nmae}}.", { first_name: "Pat" }, [
        "first_name",
      ]),
    ).toBe("Hi {{first_nmae}}.");
  });

  it("leaves an allowed-but-unsupplied variable literal", () => {
    expect(
      applyVariables(
        "Hi {{first_name}}, your code is {{otp}}.",
        { first_name: "Pat" }, // otp omitted
        ["first_name", "otp"],
      ),
    ).toBe("Hi Pat, your code is {{otp}}.");
  });

  it("rejects whitespace-padded tokens (no Handlebars-style)", () => {
    expect(
      applyVariables("Hi {{ first_name }}.", { first_name: "Pat" }, [
        "first_name",
      ]),
    ).toBe("Hi {{ first_name }}.");
  });

  it("rejects uppercase / camelCase tokens", () => {
    expect(
      applyVariables("Hi {{FirstName}}.", { FirstName: "Pat" }, ["FirstName"]),
    ).toBe("Hi {{FirstName}}.");
  });

  it("substitutes the same token multiple times", () => {
    expect(
      applyVariables("{{name}} {{name}} {{name}}", { name: "x" }, ["name"]),
    ).toBe("x x x");
  });

  it("returns empty input unchanged", () => {
    expect(applyVariables("", { x: "y" }, ["x"])).toBe("");
  });
});

describe("renderMessage", () => {
  const sampleTemplate: MessageTemplate = {
    templateKey: "rx_renewal.30_day",
    channel: "email",
    subject: "Time to renew, {{first_name}}",
    bodyHtml: "<p>Hi {{first_name}}, your prescription expires soon.</p>",
    bodyText: "Hi {{first_name}}, your prescription expires soon.",
    allowedVariables: ["first_name"],
  };

  const fallback = {
    subject: "Renew your prescription",
    bodyHtml: "<p>Renew at pennpaps.com</p>",
    bodyText: "Renew at pennpaps.com",
  };

  it("uses the looked-up template and substitutes from req.variables", async () => {
    const lookup: TemplateLookup = vi.fn(async () => sampleTemplate);
    const result = await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        variables: { first_name: "Pat" },
      },
      fallback,
      lookup,
    );
    expect(result).toEqual({
      subject: "Time to renew, Pat",
      bodyHtml: "<p>Hi Pat, your prescription expires soon.</p>",
      bodyText: "Hi Pat, your prescription expires soon.",
    });
  });

  it("falls back when lookup returns null (template missing)", async () => {
    const lookup: TemplateLookup = vi.fn(async () => null);
    const result = await renderMessage(
      {
        templateKey: "missing.key",
        channel: "email",
        variables: { first_name: "Pat" },
      },
      {
        subject: "Hi {{first_name}}",
        bodyHtml: "<p>Hi {{first_name}}</p>",
        bodyText: "Hi {{first_name}}",
      },
      lookup,
    );
    expect(result).toEqual({
      subject: "Hi Pat",
      bodyHtml: "<p>Hi Pat</p>",
      bodyText: "Hi Pat",
    });
  });

  it("falls back when lookup throws (DB outage / table missing)", async () => {
    const lookup: TemplateLookup = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        variables: { first_name: "Pat" },
      },
      {
        subject: "Hi {{first_name}}",
        bodyHtml: null,
        bodyText: "Hi {{first_name}}",
      },
      lookup,
    );
    expect(result).toEqual({
      subject: "Hi Pat",
      bodyHtml: null,
      bodyText: "Hi Pat",
    });
  });

  it("caches the lookup result across calls within TTL", async () => {
    const lookup: TemplateLookup = vi.fn(async () => sampleTemplate);
    await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        variables: { first_name: "A" },
      },
      fallback,
      lookup,
    );
    await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        variables: { first_name: "B" },
      },
      fallback,
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("re-queries after the TTL expires", async () => {
    vi.useFakeTimers();
    const lookup: TemplateLookup = vi.fn(async () => sampleTemplate);
    await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        variables: { first_name: "A" },
      },
      fallback,
      lookup,
    );
    // Advance past the 5-min TTL.
    vi.advanceTimersByTime(6 * 60 * 1000);
    await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        variables: { first_name: "B" },
      },
      fallback,
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("partitions cache by customerId so an override doesn't leak to the global path", async () => {
    const calls: Array<{ key: string; channel: string; cust: string | null }> =
      [];
    const lookup: TemplateLookup = vi.fn(async (key, channel, cust) => {
      calls.push({ key, channel, cust });
      return sampleTemplate;
    });
    await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        customerId: "cust_a",
        variables: { first_name: "A" },
      },
      fallback,
      lookup,
    );
    await renderMessage(
      {
        templateKey: "rx_renewal.30_day",
        channel: "email",
        customerId: null,
        variables: { first_name: "G" },
      },
      fallback,
      lookup,
    );
    expect(calls).toEqual([
      { key: "rx_renewal.30_day", channel: "email", cust: "cust_a" },
      { key: "rx_renewal.30_day", channel: "email", cust: null },
    ]);
  });
});
