// Tests for the phone line-type classify+cache helper, focused on the
// NULL-safe write guard (regression: a bare `.neq("…","manual")` dropped
// every first-time classification because the column is NULL) and the
// manual-override skip.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface Call {
  method: string;
  args: unknown[];
}
const calls: Call[] = [];
let selectResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
let updateResult: { error: unknown } = { error: null };

function makeBuilder() {
  const b: Record<string, unknown> = {
    select: (...a: unknown[]) => {
      calls.push({ method: "select", args: a });
      return b;
    },
    update: (...a: unknown[]) => {
      calls.push({ method: "update", args: a });
      return b;
    },
    eq: (...a: unknown[]) => {
      calls.push({ method: "eq", args: a });
      return b;
    },
    limit: () => b,
    or: (...a: unknown[]) => {
      calls.push({ method: "or", args: a });
      return Promise.resolve(updateResult);
    },
    neq: (...a: unknown[]) => {
      calls.push({ method: "neq", args: a });
      return Promise.resolve(updateResult);
    },
    maybeSingle: () => Promise.resolve(selectResult),
  };
  return b;
}

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({ from: () => makeBuilder() }),
}));
vi.mock("@workspace/resupply-domain", () => ({
  normalizeE164: (v: string | null | undefined) => (v ? String(v) : null),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { classifyAndCachePhoneLineType } from "./phone-line-type";

beforeEach(() => {
  calls.length = 0;
  selectResult = { data: null, error: null };
  updateResult = { error: null };
});

describe("classifyAndCachePhoneLineType", () => {
  it("classifies a NULL-source row and uses a NULL-safe write guard", async () => {
    selectResult = {
      data: {
        phone_e164: "+12155551212",
        phone_line_type: null,
        phone_line_type_source: null,
      },
      error: null,
    };
    const client = {
      lookupLineType: vi.fn(async () => ({
        lineType: "mobile" as const,
        rawType: "mobile",
      })),
    };
    const result = await classifyAndCachePhoneLineType({
      orgId: "o1",
      kind: "patient",
      id: "p1",
      client,
    });
    expect(result).toBe("mobile");
    const update = calls.find((c) => c.method === "update");
    expect(
      (update!.args[0] as { phone_line_type: string }).phone_line_type,
    ).toBe("mobile");
    // The write guard must be NULL-safe (an `.or` that includes is.null),
    // NOT a bare `.neq` that would drop NULL-source rows under SQL 3VL.
    const orCall = calls.find((c) => c.method === "or");
    expect(orCall).toBeDefined();
    expect(String(orCall!.args[0])).toContain("phone_line_type_source.is.null");
    expect(calls.find((c) => c.method === "neq")).toBeUndefined();
  });

  it("skips a manual-source row without calling Lookup (override wins)", async () => {
    selectResult = {
      data: {
        phone_e164: "+12155551212",
        phone_line_type: "landline",
        phone_line_type_source: "manual",
      },
      error: null,
    };
    const client = {
      lookupLineType: vi.fn(async () => ({
        lineType: "mobile" as const,
        rawType: "mobile",
      })),
    };
    const result = await classifyAndCachePhoneLineType({
      orgId: "o1",
      kind: "patient",
      id: "p1",
      client,
    });
    expect(result).toBeNull();
    expect(client.lookupLineType).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === "update")).toBeUndefined();
  });

  it("skips when the row has no phone", async () => {
    selectResult = {
      data: {
        phone_e164: null,
        phone_line_type: null,
        phone_line_type_source: null,
      },
      error: null,
    };
    const client = {
      lookupLineType: vi.fn(async () => ({
        lineType: "mobile" as const,
        rawType: "mobile",
      })),
    };
    const result = await classifyAndCachePhoneLineType({
      orgId: "o1",
      kind: "patient",
      id: "p1",
      client,
    });
    expect(result).toBeNull();
    expect(client.lookupLineType).not.toHaveBeenCalled();
  });
});
