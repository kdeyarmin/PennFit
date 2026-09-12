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
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  clearSessionCache,
  SessionMutationCache,
} from "@workspace/resupply-auth-react";

const { readPacket, readTemplates, updatePacket } = vi.hoisted(() => ({
  readPacket: vi.fn(),
  readTemplates: vi.fn(),
  updatePacket: vi.fn(),
}));
vi.mock("@workspace/api-client-react/admin", () => ({
  ApiError: class extends Error {},
  usePatientPacket: (id: string) =>
    useQuery({ queryKey: ["packet", id], queryFn: () => readPacket(id) }),
  usePatientPacketTemplates: () =>
    useQuery({ queryKey: ["templates"], queryFn: readTemplates }),
  useUpdatePatientPacket: () => useMutation({ mutationFn: updatePacket }),
  getPatientPacketQueryKey: (id: string) => ["packet", id],
}));
import { PacketEditForm } from "./PacketEditForm";

const detail = {
  packet: { title: "Recorded delivery", delivery_details: null },
  documents: [{ document_key: "consent" }],
};
const templates = {
  templates: [{ key: "consent", title: "Consent", required: true }],
};

function mount() {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const saved = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PacketEditForm packetId="packet-1" onSaved={saved} onCancel={vi.fn()} />
    </QueryClientProvider>,
  );
  return { client, saved };
}

beforeEach(() => {
  vi.clearAllMocks();
  readPacket.mockResolvedValue(detail);
  readTemplates.mockResolvedValue(templates);
  updatePacket.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it.each(["packet", "templates"])(
  "shows a retryable %s read error instead of an endless loading state",
  async (source) => {
    const reader = source === "packet" ? readPacket : readTemplates;
    reader.mockRejectedValueOnce(new Error(`${source} unavailable`));
    mount();
    expect(await screen.findByText(`${source} unavailable`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    expect(
      await screen.findByRole("button", { name: "Save changes", exact: true }),
    ).toBeTruthy();
    expect(screen.queryByText(`${source} unavailable`)).toBeNull();
  },
);

it.each(["success", "failure"])(
  "ignores a late save %s after the session changes",
  async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    updatePacket.mockReturnValue(
      new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const { client, saved } = mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(
      await screen.findByRole("button", { name: "Save changes", exact: true }),
    );
    await waitFor(() => expect(updatePacket).toHaveBeenCalled());
    await act(() => clearSessionCache(client));
    invalidate.mockClear();
    await act(async () => {
      client.setQueryData(["packet", "packet-1"], detail);
      client.setQueryData(["templates"], templates);
      if (outcome === "success") resolve({ ok: true });
      else reject(new Error("Late save failure"));
    });
    expect(saved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByText("Late save failure")).toBeNull();
  },
);
