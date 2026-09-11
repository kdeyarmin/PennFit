// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearSessionCache } from "@workspace/resupply-auth-react";
import { getListPatientNotesQueryKey } from "@workspace/api-client-react/admin";

const { updatePatient, createNote, listNotes } = vi.hoisted(() => ({
  updatePatient: vi.fn(),
  createNote: vi.fn(),
  listNotes: vi.fn(),
}));
vi.mock("@workspace/api-client-react/admin", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/api-client-react/admin")>();
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...actual,
    useGetPatient: (id: string) => ({
      data: {
        id,
        firstName: id === "first" ? "First" : "Second",
        lastName: "Patient",
        status: "active",
        hasEmail: false,
        hasPhone: false,
        pacwareId: null,
        insurancePayer: null,
        cadenceOverrideDays: null,
        channelPreference: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
        prescriptions: [],
        episodes: [],
        conversations: [],
        fulfillments: [],
      },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useGetAdminMe: () => ({ data: { multiLocationEnabled: false } }),
    useUpdatePatient: () => ({ mutateAsync: updatePatient, isPending: false }),
    useListPatientNotes: (id: string) =>
      useQuery({
        queryKey: actual.getListPatientNotesQueryKey(id),
        queryFn: listNotes,
        staleTime: Infinity,
      }),
    useCreatePatientNote: () => ({ mutateAsync: createNote, isPending: false }),
  };
});
vi.mock("@/lib/admin/feature-flags-api", () => ({
  listFeatureFlags: async () => ({ flags: [] }),
}));
vi.mock("@/components/admin/PatientActionBar", () => ({
  PatientActionBar: () => null,
}));
vi.mock("@/components/admin/ClickToDialCard", () => ({
  ClickToDialCard: () => null,
}));
vi.mock("@/components/admin/LogInterventionCard", () => ({
  LogInterventionCard: () => null,
}));
vi.mock("@/components/admin/PatientCmnCard", () => ({
  PatientCmnCard: () => null,
}));
vi.mock("@/pages/admin/patient-detail/TimelineTab", () => ({
  TimelineTab: () => null,
}));
vi.mock("@/components/admin/PatientSupplyOverview", () => ({
  PatientSupplyOverview: () => <p>Supply overview</p>,
}));
vi.mock("@/components/admin/PatientResupplyTab", () => ({
  PatientResupplyTab: () => null,
}));

import { PatientDetailPage } from "./patient-detail";

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/admin/patients/first");
});
afterEach(cleanup);

describe("switching between cached patient records", () => {
  it("discards the previous patient's unsaved reminder settings and PacWare ID", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const page = (id: string) => (
      <QueryClientProvider client={client}>
        <PatientDetailPage id={id} />
      </QueryClientProvider>
    );
    const view = render(page("first"));
    fireEvent.change(screen.getByLabelText("Insurance payer"), {
      target: { value: "First patient's payer" },
    });
    fireEvent.change(screen.getByLabelText("Cadence override (days)"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("PacWare ID"), {
      target: { value: "FIRST-PATIENT-ID" },
    });

    // React Query can already have the destination patient cached, so no
    // loading spinner unmounts the form during this prop change.
    view.rerender(page("second"));
    expect(
      screen.getByRole("heading", { name: "Second Patient" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Insurance payer") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText("Cadence override (days)") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(screen.queryByLabelText("PacWare ID")).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updatePatient).not.toHaveBeenCalled();
  });

  it("honors a new tab deep link while the same patient page remains mounted", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PatientDetailPage id="first" />
      </QueryClientProvider>,
    );
    expect(
      screen
        .getByRole("tab", { name: "Timeline" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    act(() =>
      window.history.pushState(
        {},
        "",
        "/admin/patients/first?tab=resupply&source=calendar",
      ),
    );
    expect(
      screen
        .getByRole("tab", { name: "Resupply" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("Supply overview")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe(
      "timeline",
    );
    expect(new URLSearchParams(window.location.search).get("source")).toBe(
      "calendar",
    );
    act(() =>
      window.history.pushState({}, "", "/admin/patients/first?tab=resupply"),
    );
    expect(
      screen
        .getByRole("tab", { name: "Resupply" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it.each(["success", "failure"])(
    "does not restore or refetch patient notes after a session change and late %s",
    async (outcome) => {
      let resolveNote!: () => void;
      let rejectNote!: (error: Error) => void;
      createNote.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          resolveNote = resolve;
          rejectNote = reject;
        }),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const notesKey = getListPatientNotesQueryKey("first");
      client.setQueryData(notesKey, {
        items: [
          {
            id: "old-note",
            body: "Old session private note",
            authorEmail: "staff@example.test",
            createdAt: "2026-09-01T00:00:00Z",
          },
        ],
        count: 1,
      });
      window.history.replaceState({}, "", "/admin/patients/first?tab=notes");
      const view = render(
        <QueryClientProvider client={client}>
          <PatientDetailPage id="first" />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText("Add a note"), {
        target: { value: "Pending patient note" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
      await waitFor(() => expect(createNote).toHaveBeenCalled());
      view.unmount();
      await clearSessionCache(client);

      await act(async () => {
        if (outcome === "failure") rejectNote(new Error("Late failure"));
        else resolveNote();
      });

      expect(client.getQueryData(notesKey)).toBeUndefined();
      expect(listNotes).not.toHaveBeenCalled();
    },
  );
});
