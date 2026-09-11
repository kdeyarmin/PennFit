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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const { getItem, sign, decline } = vi.hoisted(() => ({
  getItem: vi.fn(),
  sign: vi.fn(),
  decline: vi.fn(),
}));
vi.mock("@/lib/provider/provider-api", async () => ({
  ...(await vi.importActual("@/lib/provider/provider-api")),
  getProviderQueueItem: getItem,
  signProviderDocument: sign,
  declineProviderDocument: decline,
}));
vi.mock("./provider-ui", async () => ({
  ...(await vi.importActual("./provider-ui")),
  ProviderShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/signature-pad", () => ({ SignaturePad: () => null }));
import { ProviderSignDocument } from "./provider-sign-document";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const location = memoryLocation({ path: "/provider/sign/first" });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook}>
        <Route path="/provider/sign/:id">
          {(params) => (
            <ProviderSignDocument
              id={params.id}
              providerName="Fixture Clinician"
            />
          )}
        </Route>
      </Router>
    </QueryClientProvider>,
  );
  return location;
}

beforeEach(() => {
  vi.resetAllMocks();
  getItem.mockImplementation(async (id: string) => ({
    id,
    title: `Document ${id}`,
    subjectLabel: "Prescription",
    patientName: `Patient ${id}`,
    status: "pending",
    detail: {},
    createdAt: "2026-09-01T12:00:00Z",
    expiresAt: null,
  }));
  sign.mockResolvedValue({
    ok: true,
    status: "signed",
    signedAt: "2026-09-11T12:00:00Z",
  });
  decline.mockResolvedValue({ ok: true, status: "declined" });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

async function consent() {
  await screen.findByRole("heading", { name: "Document first" });
  fireEvent.click(screen.getByRole("checkbox"));
}

describe("provider document signing", () => {
  it("requires fresh consent after navigating directly to another document", async () => {
    const location = mount();
    await consent();
    await act(async () => location.navigate("/provider/sign/second"));
    await screen.findByRole("heading", { name: "Document second" });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Sign document",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  it("keeps a late signature result attached to its original document", async () => {
    const pending = deferred<unknown>();
    sign.mockReturnValue(pending.promise);
    const location = mount();
    await consent();
    fireEvent.click(screen.getByRole("button", { name: "Sign document" }));
    await waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
    await act(async () => location.navigate("/provider/sign/second"));
    await screen.findByRole("heading", { name: "Document second" });
    await act(async () => pending.resolve({ ok: true, status: "signed" }));
    expect(screen.queryByText("Signature recorded")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Document second" }),
    ).toBeTruthy();
  });

  it("blocks duplicate and conflicting actions while signing, then allows retry after failure", async () => {
    const pending = deferred<unknown>();
    sign.mockReturnValueOnce(pending.promise);
    mount();
    await consent();
    const button = screen.getByRole("button", { name: "Sign document" });
    const form = button.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
    expect(
      (
        screen.getByRole("button", {
          name: "Decline",
          exact: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Decline", exact: true }),
    );
    expect(
      screen.queryByRole("button", { name: "Confirm decline" }),
    ).toBeNull();
    await act(async () => pending.reject(new Error("Connection interrupted")));
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Sign document" }));
    expect(await screen.findByText("Signature recorded")).toBeTruthy();
    expect(sign).toHaveBeenCalledTimes(2);
    expect(decline).not.toHaveBeenCalled();
  });

  it("keeps the decline decision locked until the response arrives", async () => {
    const pending = deferred<unknown>();
    decline.mockReturnValue(pending.promise);
    mount();
    await consent();
    fireEvent.click(
      screen.getByRole("button", { name: "Decline", exact: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm decline" }));
    await waitFor(() => expect(decline).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Sign document" })).toBeNull();
    await act(async () => pending.resolve({ ok: true, status: "declined" }));
    expect(await screen.findByText("Document declined")).toBeTruthy();
    expect(sign).not.toHaveBeenCalled();
  });

  it("retries a failed document read without losing the signing route", async () => {
    getItem.mockRejectedValueOnce(new Error("Connection interrupted"));
    mount();
    await screen.findByText("This document could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Document first" }),
    ).toBeTruthy();
    expect(getItem).toHaveBeenCalledTimes(2);
    expect(getItem).toHaveBeenLastCalledWith("first");
  });
});
