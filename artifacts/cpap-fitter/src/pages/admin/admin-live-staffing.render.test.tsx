// @vitest-environment jsdom
//
// Render tests for the live-staffing page (CSR #C3). Mocks React Query so
// the page renders against fixed data, then asserts the per-agent table +
// the summary stats.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import type { LiveStaffingSnapshot } from "@/lib/admin/live-staffing-api";

const { queryState } = vi.hoisted(() => ({
  queryState: { current: null as unknown },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => queryState.current,
  };
});

vi.mock("@/lib/admin/live-staffing-api", () => ({
  getLiveStaffing: vi.fn(),
}));

import { AdminLiveStaffingPage } from "./admin-live-staffing";

function withData(data: LiveStaffingSnapshot) {
  queryState.current = {
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

beforeEach(() => cleanup());

describe("AdminLiveStaffingPage", () => {
  it("renders per-agent load, availability, shift, and backlog", () => {
    withData({
      activeAgents: 2,
      onShiftAgents: 1,
      totalOpenConversations: 4,
      unassignedOpenConversations: 1,
      agents: [
        {
          adminUserId: "a",
          email: "a@penn.example.com",
          displayName: "Alice",
          role: "csr",
          availability: "available",
          onShift: true,
          openConversations: 3,
        },
        {
          adminUserId: "b",
          email: "b@penn.example.com",
          displayName: "Bob",
          role: "csr",
          availability: "away",
          onShift: false,
          openConversations: 0,
        },
      ],
    });

    render(<AdminLiveStaffingPage />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    // "On shift" appears both as a summary stat label and Alice's row cell.
    expect(screen.getAllByText("On shift").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Away")).toBeTruthy();
    // Backlog + summary stats render.
    expect(screen.getByText("Unassigned backlog")).toBeTruthy();
  });

  it("shows an empty-roster message", () => {
    withData({
      activeAgents: 0,
      onShiftAgents: 0,
      totalOpenConversations: 0,
      unassignedOpenConversations: 0,
      agents: [],
    });
    render(<AdminLiveStaffingPage />);
    expect(screen.getByText(/No active agents/)).toBeTruthy();
  });
});
