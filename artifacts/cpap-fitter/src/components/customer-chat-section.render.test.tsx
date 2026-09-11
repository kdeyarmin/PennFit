// @vitest-environment jsdom
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { identity, stream, toast } = vi.hoisted(() => ({
  identity: vi.fn(),
  stream: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/identity", () => ({ useShopIdentity: identity }));
vi.mock("@/lib/contact", () => ({
  useCompanyContact: () => ({
    assistantStorefrontName: "Assistant",
    phoneDisplay: "555-0100",
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/customer-chat-api", async () => ({
  ...(await vi.importActual("@/lib/customer-chat-api")),
  streamCustomerChatMessage: stream,
}));
import { CustomerChatSection } from "./customer-chat-section";

const storageKey = "pennpaps_account_chat_v1";
const privateMessage = {
  id: "prior",
  role: "assistant",
  content: "Account A private order history",
};
const clients: QueryClient[] = [];
function useAccount(userId: string) {
  identity.mockReturnValue({
    userId,
    isLoaded: true,
    isSignedIn: true,
    displayName: userId,
  });
}
function mount() {
  const client = new QueryClient();
  clients.push(client);
  const view = () => (
    <QueryClientProvider client={client}>
      <CustomerChatSection />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { client, rerender: () => rendered.rerender(view()) };
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  useAccount("account-a");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  sessionStorage.clear();
});

describe("account chat session isolation", () => {
  it.each([
    [privateMessage],
    { ownerId: "account-a", messages: [privateMessage] },
  ])(
    "does not restore a transcript without matching ownership (%j)",
    (persisted) => {
      sessionStorage.setItem(storageKey, JSON.stringify(persisted));
      useAccount("account-b");
      mount();
      expect(screen.queryByText(privateMessage.content)).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({
        ownerId: "account-b",
        messages: [],
      });
    },
  );

  it("restores the current account's conversation on remount", () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ ownerId: "account-a", messages: [privateMessage] }),
    );
    mount();
    expect(screen.getByText(privateMessage.content)).toBeTruthy();
  });

  it("clears the transcript and unfinished draft when the mounted account changes", async () => {
    stream.mockImplementation(async (_messages, onChunk) => {
      onChunk(privateMessage.content);
      return {};
    });
    const { rerender } = mount();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(privateMessage.content);
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Account A unfinished question" },
    });
    useAccount("account-b");
    rerender();
    expect(screen.queryByText(privateMessage.content)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({
      ownerId: "account-b",
      messages: [],
    });
  });

  it("ignores old stream chunks and completion effects after the session changes", async () => {
    let finish!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      finish = resolve;
    });
    stream.mockReturnValue(response);
    const { client, rerender } = mount();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(stream).toHaveBeenCalledOnce());
    const [, onChunk, signal] = stream.mock.calls[0]!;
    await act(() => clearSessionCache(client));
    act(() => onChunk(privateMessage.content));
    expect(screen.queryByText(privateMessage.content)).toBeNull();
    useAccount("account-b");
    rerender();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish({ unauthorized: true });
    });
    expect(toast).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({
      ownerId: "account-b",
      messages: [],
    });
  });

  it.each(["Partial reply", ""])(
    "finishes a cancelled current chat without leaving streaming placeholders (%j)",
    async (partial) => {
      stream.mockImplementation(async (_messages, onChunk) => {
        if (partial) onChunk(partial);
        throw new DOMException("Cancelled", "AbortError");
      });
      mount();
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "My orders" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(
          (screen.getByRole("textbox") as HTMLTextAreaElement).disabled,
        ).toBe(false),
      );
      expect(screen.queryByLabelText("Thinking")).toBeNull();
      if (partial) expect(screen.getByText(partial)).toBeTruthy();
      else expect(screen.queryByTestId("customer-chat-bot-bubble")).toBeNull();
      const stored = JSON.parse(sessionStorage.getItem(storageKey)!);
      expect(
        stored.messages.filter(
          (message: { role: string }) => message.role === "assistant",
        ),
      ).toEqual(
        partial
          ? [expect.objectContaining({ content: partial, streaming: false })]
          : [],
      );
      expect(toast).not.toHaveBeenCalled();
    },
  );
});
