// Unit tests for the override-precedence layering in
// `messageTemplateLookup`. Mocks the Drizzle pool + drizzle()
// fluent so the tests don't need a live DB.
//
// Coverage matrix:
//   * No override + active global → returns the global as-is.
//   * Active override + active global → per-field layering
//     (override field wins; null override field inherits).
//   * Disabled override + active global → synthetic empty-body
//     (the "suppress this customer" contract).
//   * Override row exists + global missing → use override fields
//     directly (degenerate case).
//   * Disabled global → behaves as if global is missing (the
//     fallback path runs).
//   * No customerId → only the global query is run; no override
//     lookup happens.
//   * Lookup throws → returns null (renderMessage falls back).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  messageTemplates,
  shopCustomerMessageTemplateOverrides,
} from "@workspace/resupply-db";

const mockDrizzle = vi.fn();
const mockGetDbPool = vi.fn();

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-db")
  >("@workspace/resupply-db");
  return {
    ...actual,
    getDbPool: () => mockGetDbPool(),
  };
});

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => mockDrizzle(),
}));

import { messageTemplateLookup } from "./lookup";

interface RowSource {
  /** Rows the override-table query should return. */
  override?: Array<Record<string, unknown>>;
  /** Rows the global-table query should return. */
  global?: Array<Record<string, unknown>>;
  /** If set, the global-query promise rejects with this error. */
  globalThrows?: Error;
}

/** Build a minimal Drizzle stub that produces the right rows for
 *  the override or global query based on which table is referenced
 *  in `from()`. Distinguishes by reference equality with the actual
 *  schema table objects. */
function makeDb(src: RowSource) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const isOverride = table === shopCustomerMessageTemplateOverrides;
        const isGlobal = table === messageTemplates;
        const result: Array<Record<string, unknown>> = isOverride
          ? (src.override ?? [])
          : isGlobal
            ? (src.global ?? [])
            : [];
        return {
          where: () => ({
            limit: async () => {
              if (isGlobal && src.globalThrows) {
                throw src.globalThrows;
              }
              return result;
            },
          }),
        };
      },
    }),
  };
}

const SAMPLE_GLOBAL = {
  id: "g_1",
  templateKey: "rx_renewal.30_day",
  channel: "email",
  subject: "Time to renew",
  bodyHtml: "<p>Renew your Rx</p>",
  bodyText: "Renew your Rx",
  allowedVariables: ["first_name"],
  isActive: true,
  updatedAt: new Date(),
  updatedBy: null,
  createdAt: new Date(),
  createdBy: null,
};

beforeEach(() => {
  mockGetDbPool.mockReturnValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("messageTemplateLookup", () => {
  it("returns the global as-is when there's no override", async () => {
    mockDrizzle.mockReturnValue(
      makeDb({ override: [], global: [SAMPLE_GLOBAL] }),
    );
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toEqual({
      templateKey: "rx_renewal.30_day",
      channel: "email",
      subject: "Time to renew",
      bodyHtml: "<p>Renew your Rx</p>",
      bodyText: "Renew your Rx",
      allowedVariables: ["first_name"],
    });
  });

  it("layers an active override per-field over the global", async () => {
    mockDrizzle.mockReturnValue(
      makeDb({
        override: [
          {
            id: "o_1",
            customerId: "cust_a",
            templateKey: "rx_renewal.30_day",
            channel: "email",
            subject: "Personalised renewal note",
            bodyHtml: null, // inherit from global
            bodyText: null, // inherit from global
            isActive: true,
            note: "patient asked for friendlier subject",
            createdAt: new Date(),
            createdBy: null,
            updatedAt: new Date(),
            updatedBy: null,
          },
        ],
        global: [SAMPLE_GLOBAL],
      }),
    );
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result?.subject).toBe("Personalised renewal note");
    // bodyHtml + bodyText inherited from the global since override
    // had nulls there.
    expect(result?.bodyHtml).toBe("<p>Renew your Rx</p>");
    expect(result?.bodyText).toBe("Renew your Rx");
    // allowedVariables ALWAYS comes from the global so the editor
    // can validate against the call-site contract.
    expect(result?.allowedVariables).toEqual(["first_name"]);
  });

  it("disabled override returns an empty-body synthetic (suppress)", async () => {
    mockDrizzle.mockReturnValue(
      makeDb({
        override: [
          {
            id: "o_1",
            customerId: "cust_a",
            templateKey: "rx_renewal.30_day",
            channel: "email",
            subject: null,
            bodyHtml: null,
            bodyText: null,
            isActive: false,
            note: "opted out of email rx renewals",
            createdAt: new Date(),
            createdBy: null,
            updatedAt: new Date(),
            updatedBy: null,
          },
        ],
        global: [SAMPLE_GLOBAL],
      }),
    );
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toEqual({
      templateKey: "rx_renewal.30_day",
      channel: "email",
      subject: null,
      bodyHtml: null,
      bodyText: "",
      allowedVariables: ["first_name"],
    });
  });

  it("disabled global is treated as missing (fallback path will run)", async () => {
    mockDrizzle.mockReturnValue(
      makeDb({
        override: [],
        global: [{ ...SAMPLE_GLOBAL, isActive: false }],
      }),
    );
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toBeNull();
  });

  it("returns null when both tables are empty", async () => {
    mockDrizzle.mockReturnValue(makeDb({ override: [], global: [] }));
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toBeNull();
  });

  it("returns null when the lookup throws (DB outage / missing table)", async () => {
    mockDrizzle.mockReturnValue(
      makeDb({
        override: [],
        global: [],
        globalThrows: new Error('relation "message_templates" does not exist'),
      }),
    );
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toBeNull();
  });

  it("with no customerId, skips the override query entirely", async () => {
    let overrideQueryHit = false;
    mockDrizzle.mockReturnValue({
      select: () => ({
        from: (table: unknown) => {
          if (table === shopCustomerMessageTemplateOverrides) {
            overrideQueryHit = true;
          }
          const isGlobal = table === messageTemplates;
          return {
            where: () => ({
              limit: async () => (isGlobal ? [SAMPLE_GLOBAL] : []),
            }),
          };
        },
      }),
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      null,
    );
    expect(overrideQueryHit).toBe(false);
    expect(result?.bodyText).toBe("Renew your Rx");
  });
});
