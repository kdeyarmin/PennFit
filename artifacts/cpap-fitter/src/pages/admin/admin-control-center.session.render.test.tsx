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

const { listFlags, listActivity, toggleFlag } = vi.hoisted(() => ({
  listFlags: vi.fn(),
  listActivity: vi.fn(),
  toggleFlag: vi.fn(),
}));
vi.mock("@/lib/admin/feature-flags-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/admin/feature-flags-api")>()),
  listFeatureFlags: listFlags,
  listFeatureFlagActivity: listActivity,
  toggleFeatureFlag: toggleFlag,
}));
vi.mock("@workspace/api-client-react/admin", async (importActual) => ({
  ...(await importActual<typeof import("@workspace/api-client-react/admin")>()),
  useGetAdminMe: () => ({ data: { isSuperAdmin: true } }),
}));

import { AdminControlCenterPage } from "./admin-control-center";

beforeEach(() => {
  vi.clearAllMocks();
  listFlags.mockResolvedValue({
    flags: [
      {
        key: "resupply.reminders",
        enabled: false,
        description: "Reminders",
        category: "Resupply",
        updatedByEmail: null,
        updatedAt: "2026-09-01T00:00:00Z",
      },
    ],
  });
  listActivity.mockResolvedValue({ activity: [] });
  toggleFlag.mockResolvedValue({});
});
afterEach(cleanup);

it("still sends feature toggles within the original session", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdminControlCenterPage />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("switch"));
  await waitFor(() =>
    expect(toggleFlag).toHaveBeenCalledWith("resupply.reminders", true),
  );
});

it("does not send a feature toggle after the session changes during query cancellation", async () => {
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
      <AdminControlCenterPage />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("switch"));
  await waitFor(() => expect(cancel).toHaveBeenCalled());
  const mutation = client.getMutationCache().getAll()[0]!;
  view.unmount();
  await clearSessionCache(client);

  await act(async () => releaseCancellation());
  await waitFor(() => expect(mutation.state.status).not.toBe("pending"));
  expect(toggleFlag).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(client.getQueryData(["admin-feature-flags"])).toBeUndefined();
});
