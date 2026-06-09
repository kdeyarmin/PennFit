// @vitest-environment jsdom
//
// Render tests for the Locations admin page (multi-location #O1). Mocks
// React Query + the locations api so the page renders against fixed
// data, then asserts the branch table + admin-root scoping.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import type { Location } from "@/lib/admin/locations-api";

const { queryState } = vi.hoisted(() => ({
  queryState: { current: null as unknown },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: () => queryState.current,
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("@/lib/admin/locations-api", () => ({
  LOCATIONS_QUERY_KEY: ["admin", "locations"],
  listLocations: vi.fn(),
  createLocation: vi.fn(),
  updateLocation: vi.fn(),
  describeLocationError: (e: unknown) => String(e),
}));

import { AdminLocationsPage } from "./admin-locations";

function withLocations(locations: Location[]): void {
  queryState.current = {
    data: { locations, primaryId: locations.find((l) => l.isPrimary)?.id ?? null },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

function makeLocation(over: Partial<Location>): Location {
  return {
    id: "loc-1",
    name: "Pittsburgh",
    code: "PGH",
    addressLine1: "100 Main St",
    addressLine2: null,
    city: "Pittsburgh",
    state: "PA",
    postalCode: "15201",
    phoneE164: "+14125551212",
    npi: null,
    isPrimary: true,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  cleanup();
});

describe("AdminLocationsPage", () => {
  it("renders the branch table with names and a primary badge", () => {
    withLocations([
      makeLocation({}),
      makeLocation({
        id: "loc-2",
        name: "Erie",
        code: "ERI",
        isPrimary: false,
        isActive: false,
      }),
    ]);
    render(<AdminLocationsPage />);

    expect(screen.getByText("Pittsburgh")).toBeTruthy();
    expect(screen.getByText("Erie")).toBeTruthy();
    expect(screen.getByText("Primary")).toBeTruthy();
    // The deactivated branch shows an "Off" active badge.
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByText("+ New location")).toBeTruthy();
  });

  it("shows an empty state when there are no locations", () => {
    withLocations([]);
    render(<AdminLocationsPage />);
    expect(screen.getByText("No locations yet.")).toBeTruthy();
  });

  it("wraps its outer div in admin-root (scoping rule)", () => {
    withLocations([makeLocation({})]);
    const { container } = render(<AdminLocationsPage />);
    expect(container.querySelector(".admin-root")).toBeTruthy();
  });
});
