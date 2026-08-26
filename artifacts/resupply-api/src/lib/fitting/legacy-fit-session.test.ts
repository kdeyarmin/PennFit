import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  insertPayload: null as Record<string, unknown> | null,
  maskId: "mask-uuid-1" as string | null,
  maskError: null as { message: string } | null,
  insertError: null as { message: string } | null,
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            or: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.maskId ? { id: state.maskId } : null,
                      error: state.maskError,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
    from: (table: string) => {
      expect(table).toBe("fit_sessions");
      return {
        insert: (payload: Record<string, unknown>) => {
          state.insertPayload = payload;
          return {
            select: () => ({
              single: async () =>
                state.insertError
                  ? { data: null, error: state.insertError }
                  : { data: { id: "session-1" }, error: null },
            }),
          };
        },
      };
    },
  }),
}));

vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createLegacyFitSessionForRequest } from "./legacy-fit-session";

describe("createLegacyFitSessionForRequest", () => {
  beforeEach(() => {
    state.insertPayload = null;
    state.maskId = "mask-uuid-1";
    state.maskError = null;
    state.insertError = null;
  });

  it("inserts a degraded recommended session with resolved mask FK", async () => {
    const id = await createLegacyFitSessionForRequest({
      orgId: "org-1",
      population: "adult",
      recommendedMaskId: "resmed-airfit-f20",
      recommendedMaskName: "AirFit F20",
      recommendedMaskType: "fullFace",
      recommendedMaskSize: "M",
    });
    expect(id).toBe("session-1");
    expect(state.insertPayload).toMatchObject({
      degraded: true,
      status: "recommended",
      population: "adult",
      primary_mask_model_id: "mask-uuid-1",
    });
  });

  it("returns null when the insert fails (fail-soft)", async () => {
    state.insertError = { message: "boom" };
    const id = await createLegacyFitSessionForRequest({
      orgId: "org-1",
      population: "pediatric",
    });
    expect(id).toBeNull();
  });
});
