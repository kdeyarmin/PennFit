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
import {
  clearSessionCache,
  SessionMutationCache,
} from "@workspace/resupply-auth-react";
import { getGetAdminMeQueryKey } from "@workspace/api-client-react/admin";

const { refetchAgreements, listVisits, joinVisit, writeClipboard, toast } =
  vi.hoisted(() => ({
    refetchAgreements: vi.fn(),
    listVisits: vi.fn(),
    joinVisit: vi.fn(),
    writeClipboard: vi.fn(),
    toast: vi.fn(),
  }));
vi.mock("@workspace/api-client-react/admin", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/api-client-react/admin")>();
  const { useMutation } = await import("@tanstack/react-query");
  return {
    ...actual,
    useAdminAgreements: () => ({
      data: {
        agreements: [
          {
            type: "msa",
            version: "v1",
            title: "Service agreement",
            body: "Agreement text",
            accepted: false,
          },
        ],
      },
      isPending: false,
      isError: false,
      refetch: refetchAgreements,
    }),
    useAcceptAgreement: () =>
      useMutation({ mutationFn: async () => ({ allSigned: true }) }),
  };
});
vi.mock("@/lib/admin/video-visits-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/admin/video-visits-api")>()),
  listVideoVisits: listVisits,
  joinVideoVisit: joinVisit,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { AgreementsGate } from "./agreements-gate";
import { AdminVideoVisitsPage } from "./admin-video-visits";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeClipboard },
  });
  listVisits.mockResolvedValue({
    visits: [
      {
        id: "visit-1",
        status: "scheduled",
        patientName: "Example Patient",
        purpose: "setup",
        createdAt: "2026-09-01T00:00:00Z",
      },
    ],
  });
  joinVisit.mockResolvedValue({
    patientJoinUrl: "https://example.test/video/private-patient-token",
  });
});
afterEach(() => {
  cleanup();
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function client() {
  return new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false } },
  });
}

it.each([false, true])(
  "finishes agreement refresh only in the original session (changed=%s)",
  async (changed) => {
    let finishRefetch!: () => void;
    refetchAgreements.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRefetch = resolve;
      }),
    );
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AgreementsGate />
      </QueryClientProvider>,
    );
    fireEvent.change(
      screen.getByLabelText("Full legal name of authorized signatory"),
      { target: { value: "Example Owner" } },
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Accept and finish" }));
    await waitFor(() => expect(refetchAgreements).toHaveBeenCalled());
    if (changed) {
      view.unmount();
      await clearSessionCache(queryClient);
    }
    await act(async () => finishRefetch());
    if (changed)
      expect(invalidate).not.toHaveBeenCalledWith({
        queryKey: getGetAdminMeQueryKey(),
      });
    else
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: getGetAdminMeQueryKey(),
        }),
      );
  },
);

it.each([false, true])(
  "shows a clipboard failure link only in the original session (changed=%s)",
  async (changed) => {
    let failClipboard!: (error: Error) => void;
    writeClipboard.mockReturnValue(
      new Promise<void>((_, reject) => {
        failClipboard = reject;
      }),
    );
    const queryClient = client();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AdminVideoVisitsPage />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeClipboard).toHaveBeenCalled());
    if (changed) {
      view.unmount();
      await clearSessionCache(queryClient);
    }
    await act(async () =>
      failClipboard(new Error("Clipboard permission denied")),
    );
    if (changed) expect(toast).not.toHaveBeenCalled();
    else
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          title: "Couldn't copy automatically",
          description: "https://example.test/video/private-patient-token",
        }),
      );
  },
);
