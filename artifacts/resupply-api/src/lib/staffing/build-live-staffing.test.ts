import { describe, expect, it } from "vitest";

import { buildLiveStaffing } from "./build-live-staffing";

const agent = (
  id: string,
  over: Partial<{
    email: string;
    displayName: string | null;
    role: string;
    availability: string;
  }> = {},
) => ({
  id,
  email: over.email ?? `${id}@penn.example.com`,
  displayName: over.displayName ?? null,
  role: over.role ?? "csr",
  availability: over.availability ?? "available",
});

describe("buildLiveStaffing", () => {
  it("counts open conversations per agent, heaviest first", () => {
    const snap = buildLiveStaffing({
      agents: [agent("a"), agent("b"), agent("c")],
      openConversationAssignees: ["a", "a", "a", "b", null, null],
      onShiftIds: ["a"],
    });
    expect(
      snap.agents.map((x) => [x.adminUserId, x.openConversations]),
    ).toEqual([
      ["a", 3],
      ["b", 1],
      ["c", 0],
    ]);
    expect(snap.agents[0]!.onShift).toBe(true);
    expect(snap.agents[1]!.onShift).toBe(false);
    expect(snap.unassignedOpenConversations).toBe(2);
    expect(snap.totalOpenConversations).toBe(6);
    expect(snap.activeAgents).toBe(3);
    expect(snap.onShiftAgents).toBe(1);
  });

  it("counts convos assigned to an unknown/inactive agent in the total only", () => {
    const snap = buildLiveStaffing({
      agents: [agent("a")],
      // "ghost" is not in the active roster (e.g. deactivated mid-shift).
      openConversationAssignees: ["a", "ghost", "ghost", null],
      onShiftIds: [],
    });
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0]!.openConversations).toBe(1);
    expect(snap.unassignedOpenConversations).toBe(1);
    // 1 (a) + 2 (ghost) + 1 (unassigned) = 4
    expect(snap.totalOpenConversations).toBe(4);
  });

  it("breaks load ties by display name then email", () => {
    const snap = buildLiveStaffing({
      agents: [
        agent("a", { displayName: "Zara" }),
        agent("b", { displayName: "Amir" }),
      ],
      openConversationAssignees: ["a", "b"],
      onShiftIds: [],
    });
    expect(snap.agents.map((x) => x.displayName)).toEqual(["Amir", "Zara"]);
  });

  it("handles an empty roster and no conversations", () => {
    const snap = buildLiveStaffing({
      agents: [],
      openConversationAssignees: [],
      onShiftIds: [],
    });
    expect(snap).toEqual({
      agents: [],
      unassignedOpenConversations: 0,
      totalOpenConversations: 0,
      activeAgents: 0,
      onShiftAgents: 0,
    });
  });
});
