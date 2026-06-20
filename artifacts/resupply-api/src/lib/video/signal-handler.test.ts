// Tenant-scoping tests for the video signaling handler.
//
// Focus: the Control Center `telehealth.video` gate is evaluated against
// the VISIT's own tenant (resolved via a global-by-id lookup) rather than
// the seed org, and a row with no org_id falls back to seed. We exercise
// the feature-DISABLED path on purpose — it returns before the room join /
// heartbeat, so the test stays free of timers and singleton room state.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── mocks (must precede SUT import) ──────────────────────────────────────

const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

const resolveSeedOrgIdMock = vi.hoisted(() => vi.fn(async () => "seed-org"));
// The row loadVisit() will "find" by id. Mutated per test.
const visitRowRef = vi.hoisted(
  () =>
    ({ current: null }) as {
      current: Record<string, unknown> | null;
    },
);

// Fake org-scoped client covering both chains the handler uses:
//   loadVisit:   .raw().schema().from().select().eq().maybeSingle()
//   updateVisit: .from().update().eq()
const getOrgScopedClientMock = vi.hoisted(() =>
  vi.fn(() => {
    const selectChain: Record<string, unknown> = {
      select: () => selectChain,
      eq: () => selectChain,
      maybeSingle: async () => ({ data: visitRowRef.current, error: null }),
    };
    return {
      raw: () => ({ schema: () => ({ from: () => selectChain }) }),
      from: () => ({
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    };
  }),
);

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: resolveSeedOrgIdMock,
  getOrgScopedClient: getOrgScopedClientMock,
}));

import { handleVideoSignalConnection } from "./signal-handler";

const VISIT_ID = "11111111-1111-4111-8111-111111111111";

function makeWs() {
  const closes: Array<{ code: number; reason: string }> = [];
  return {
    closes,
    send: vi.fn(),
    close: (code: number, reason: string) => closes.push({ code, reason }),
    terminate: vi.fn(),
    ping: vi.fn(),
    on: vi.fn(),
  };
}

beforeEach(() => {
  isFeatureEnabledMock.mockReset();
  isFeatureEnabledMock.mockResolvedValue(true);
  resolveSeedOrgIdMock.mockReset();
  resolveSeedOrgIdMock.mockResolvedValue("seed-org");
  getOrgScopedClientMock.mockClear();
  visitRowRef.current = {
    id: VISIT_ID,
    org_id: "tenant-x",
    status: "scheduled",
    link_version: 1,
    started_at: null,
    staff_joined_at: null,
    patient_joined_at: null,
  };
});

describe("handleVideoSignalConnection — tenant scoping", () => {
  it("gates telehealth.video on the visit's own org, not the seed org", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const ws = makeWs();

    await handleVideoSignalConnection(ws as never, {
      visitId: VISIT_ID,
      role: "staff",
      linkVersion: 1,
    });

    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "telehealth.video",
      "tenant-x",
    );
    expect(ws.closes).toContainEqual({
      code: 4403,
      reason: "feature-disabled",
    });
  });

  it("falls back to the seed org when the visit row has no org_id", async () => {
    visitRowRef.current!.org_id = null;
    isFeatureEnabledMock.mockResolvedValue(false);
    const ws = makeWs();

    await handleVideoSignalConnection(ws as never, {
      visitId: VISIT_ID,
      role: "staff",
      linkVersion: 1,
    });

    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "telehealth.video",
      "seed-org",
    );
  });
});
