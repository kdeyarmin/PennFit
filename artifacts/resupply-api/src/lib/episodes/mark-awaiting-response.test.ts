import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/resupply-db", () => ({}));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { markEpisodeAwaitingResponse } from "./mark-awaiting-response";

describe("markEpisodeAwaitingResponse", () => {
  it("updates only outreach_pending episodes to awaiting_response", async () => {
    const eqs: Array<[string, string]> = [];
    const supabase = {
      from: (table: string) => {
        expect(table).toBe("episodes");
        return {
          update: (payload: Record<string, unknown>) => {
            expect(payload.status).toBe("awaiting_response");
            return {
              eq: (col: string, val: string) => {
                eqs.push([col, val]);
                return {
                  eq: async (col2: string, val2: string) => {
                    eqs.push([col2, val2]);
                    return { error: null };
                  },
                };
              },
            };
          },
        };
      },
    };

    await markEpisodeAwaitingResponse(
      supabase as never,
      "ep-11111111-1111-4111-8111-111111111111",
    );

    expect(eqs).toEqual([
      ["id", "ep-11111111-1111-4111-8111-111111111111"],
      ["status", "outreach_pending"],
    ]);
  });

  it("swallows write errors (send must not fail)", async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: async () => ({ error: { message: "boom" } }),
          }),
        }),
      }),
    };
    await expect(
      markEpisodeAwaitingResponse(supabase as never, "ep-1"),
    ).resolves.toBeUndefined();
  });
});
