// @vitest-environment jsdom
//
// Render tests for the patient duplicate-review page (CSR #C1). Mocks
// React Query so the page renders against fixed data without a live
// QueryClient, then asserts the grouped table + PHI-safe markers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import type { ListPatientDuplicatesResponse } from "@/lib/admin/patients-duplicates-api";

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

vi.mock("@/lib/admin/patients-duplicates-api", () => ({
  listPatientDuplicates: vi.fn(),
}));

import { AdminPatientsDuplicatesPage } from "./admin-patients-duplicates";

function withData(data: ListPatientDuplicatesResponse) {
  queryState.current = {
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  cleanup();
});

describe("AdminPatientsDuplicatesPage", () => {
  it("renders a duplicate group with members and a reason label", () => {
    withData({
      groupCount: 1,
      groups: [
        {
          groupKey: "name|smith|1965-04-12",
          matchReason: "dob_lastname",
          memberCount: 2,
          members: [
            {
              patientId: "p1",
              firstName: "JANE",
              lastName: "SMITH",
              dateOfBirth: "1965-04-12",
              pacwareId: "PAC-1",
              status: "active",
              hasPhone: true,
              hasEmail: false,
              createdAt: "2026-01-01T00:00:00Z",
            },
            {
              patientId: "p2",
              firstName: "JAYNE",
              lastName: "SMITH",
              dateOfBirth: "1965-04-12",
              pacwareId: "PAC-2",
              status: "active",
              hasPhone: false,
              hasEmail: true,
              createdAt: "2026-02-01T00:00:00Z",
            },
          ],
        },
      ],
    });

    render(<AdminPatientsDuplicatesPage />);

    expect(
      screen.getByText(/Same last name \+ date of birth/),
    ).toBeTruthy();
    // Both records render, each linking to the admin patient detail page.
    const jane = screen.getByText("JANE SMITH") as HTMLAnchorElement;
    expect(jane.getAttribute("href")).toBe("/admin/patients/p1");
    expect(screen.getByText("JAYNE SMITH").getAttribute("href")).toBe(
      "/admin/patients/p2",
    );
    // PHI-safe reachability markers, not raw values.
    expect(screen.getAllByText("phone").length).toBeGreaterThan(0);
    expect(screen.getAllByText("email").length).toBeGreaterThan(0);
  });

  it("renders an all-clear message when there are no duplicates", () => {
    withData({ groupCount: 0, groups: [] });
    render(<AdminPatientsDuplicatesPage />);
    expect(screen.getByText(/No likely duplicates found/)).toBeTruthy();
  });
});
