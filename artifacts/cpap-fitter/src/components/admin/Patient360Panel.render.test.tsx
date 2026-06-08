// @vitest-environment jsdom
//
// Render tests for the therapy-snapshot section added to Patient360Panel
// (CSR C3). Mocks the two api-client hooks so we can assert the snapshot
// renders when there's data and is absent when there isn't.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { patientState, snapshotState } = vi.hoisted(() => ({
  patientState: { current: null as unknown },
  snapshotState: { current: null as unknown },
}));

vi.mock("@workspace/api-client-react/admin", () => ({
  useGetPatient: () => patientState.current,
  useGetPatientTherapySnapshot: () => snapshotState.current,
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

import { Patient360Panel } from "./Patient360Panel";

const PATIENT_OK = {
  data: {
    firstName: "Jordan",
    lastName: "Rivera",
    pacwareId: "123",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    hasPhone: true,
    hasEmail: true,
    channelPreference: null,
    prescriptions: [],
    episodes: [],
    fulfillments: [],
  },
  isPending: false,
  isError: false,
  error: null,
};

beforeEach(() => {
  cleanup();
  patientState.current = PATIENT_OK;
  snapshotState.current = { data: null, isPending: true, isError: false };
});

describe("Patient360Panel therapy snapshot", () => {
  it("renders the snapshot section when therapy data exists", () => {
    snapshotState.current = {
      data: {
        patientId: "p1",
        hasData: true,
        windowDays: 30,
        nightsWithData: 12,
        windowStartDate: "2026-05-01",
        windowEndDate: "2026-05-30",
        lastNightDate: "2026-05-30",
        staleDays: 1,
        avgUsageHours: 6.2,
        avgAhi: 3.1,
        avgLeakLMin: 11,
        compliantNights: 10,
        complianceRatePct: 83.3,
      },
      isPending: false,
      isError: false,
    };
    render(<Patient360Panel patientId="p1" />);
    expect(screen.getByText("Recent therapy (last 30d)")).toBeTruthy();
    expect(screen.getByText(/6.2 h\/night/)).toBeTruthy();
    expect(screen.getByText(/83.3%/)).toBeTruthy();
    expect(screen.getByText(/12 nights with data/)).toBeTruthy();
  });

  it("renders nothing for the snapshot when there is no therapy data", () => {
    snapshotState.current = {
      data: {
        patientId: "p1",
        hasData: false,
        windowDays: 30,
        nightsWithData: 0,
        windowStartDate: null,
        windowEndDate: null,
        lastNightDate: null,
        staleDays: null,
        avgUsageHours: null,
        avgAhi: null,
        avgLeakLMin: null,
        compliantNights: 0,
        complianceRatePct: null,
      },
      isPending: false,
      isError: false,
    };
    render(<Patient360Panel patientId="p1" />);
    // The main panel still renders, but no therapy section.
    expect(screen.getByText("Patient context")).toBeTruthy();
    expect(screen.queryByText("Recent therapy (last 30d)")).toBeNull();
  });

  it("renders nothing for the snapshot while it is still loading", () => {
    snapshotState.current = { data: null, isPending: true, isError: false };
    render(<Patient360Panel patientId="p1" />);
    expect(screen.queryByText("Recent therapy (last 30d)")).toBeNull();
  });
});
