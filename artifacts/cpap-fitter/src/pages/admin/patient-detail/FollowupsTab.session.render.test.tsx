// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const { listFollowups, completeFollowup } = vi.hoisted(() => ({
  listFollowups: vi.fn(),
  completeFollowup: vi.fn(),
}));
vi.mock("@/lib/admin/patient-followups-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/admin/patient-followups-api")>()),
  listAdminPatientFollowups: listFollowups,
  completeAdminPatientFollowup: completeFollowup,
}));

import { FollowupsTab } from "./FollowupsTab";

beforeEach(() => {
  vi.clearAllMocks();
  listFollowups.mockResolvedValue({
    followups: [
      {
        id: "followup-1",
        body: "Patient callback",
        dueAt: "2026-09-15T12:00:00Z",
        createdByEmail: "staff@example.test",
      },
    ],
  });
  completeFollowup.mockResolvedValue({
    id: "followup-1",
    completedAt: "2026-09-11T12:00:00Z",
  });
});
afterEach(cleanup);

it("still completes patient follow-ups within the original session", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FollowupsTab patientId="patient-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(completeFollowup).toHaveBeenCalledWith("patient-1", "followup-1"),
  );
});

it("does not complete a patient follow-up after the session changes during query cancellation", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const cancel = vi
    .spyOn(client, "cancelQueries")
    .mockImplementationOnce(() => cancellation);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <FollowupsTab patientId="patient-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() => expect(cancel).toHaveBeenCalled());
  const mutation = client.getMutationCache().getAll()[0]!;
  view.unmount();
  await clearSessionCache(client);

  await act(async () => releaseCancellation());
  await waitFor(() => expect(mutation.state.status).not.toBe("pending"));
  expect(completeFollowup).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(
    client.getQueryData(["admin", "patients", "patient-1", "followups"]),
  ).toBeUndefined();
});
