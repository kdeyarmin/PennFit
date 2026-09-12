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

const { save, preview, template } = vi.hoisted(() => ({
  save: vi.fn(),
  preview: vi.fn(),
  template: {
    key: "example-consent",
    title: "Example consent",
    version: "1",
    requiresSignature: true,
    customized: false,
    sections: [{ paragraphs: ["Original consent wording"] }],
  },
}));
vi.mock("@workspace/api-client-react/admin", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@workspace/api-client-react/admin")
  >()),
  usePatientPacketTemplates: () => ({
    data: { templates: [template], mergeTokens: [] },
    isPending: false,
    isError: false,
  }),
  useSavePacketTemplate: () => ({ mutateAsync: save, isPending: false }),
  usePreviewPacketTemplate: () => ({ mutateAsync: preview, isPending: false }),
}));
import { PacketTemplatesPanel } from "./PacketTemplatesPanel";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function startSave() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const saving = deferred();
  const refreshing = deferred();
  save.mockReturnValue(saving.promise);
  const invalidate = vi
    .spyOn(client, "invalidateQueries")
    .mockReturnValue(refreshing.promise);
  const view = render(
    <QueryClientProvider client={client}>
      <PacketTemplatesPanel onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Example consent/ }));
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Document content"), {
    target: { value: "Old tenant's edited wording" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save for all future packets" }),
  );
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  return { client, saving, refreshing, invalidate, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue({ sections: template.sections });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("packet template save continuations", () => {
  it.each(["save", "refresh"] as const)(
    "does not start an old template preview when the session changes during %s",
    async (stage) => {
      const { client, saving, refreshing, invalidate } = await startSave();
      if (stage === "refresh") {
        await act(async () => saving.resolve());
        await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
      }
      await act(() => clearSessionCache(client));
      await act(async () => {
        saving.resolve();
        refreshing.resolve();
      });

      expect(preview).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledTimes(stage === "save" ? 0 : 1);
      expect(screen.queryByText(/^Saved\. Every packet/)).toBeNull();
      client.clear();
    },
  );

  it("refreshes and previews after a save in the same session", async () => {
    const { client, saving, refreshing, invalidate } = await startSave();
    await act(async () => saving.resolve());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    await act(async () => refreshing.resolve());
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenLastCalledWith({
      key: "example-consent",
      sections: [{ paragraphs: ["Old tenant's edited wording"] }],
    });
    expect(screen.getByText(/^Saved\. Every packet/)).toBeTruthy();
    client.clear();
  });

  it("ignores a late save failure after the session changes", async () => {
    const { client, saving, invalidate } = await startSave();
    await act(() => clearSessionCache(client));
    await act(async () =>
      saving.reject(new Error("Previous tenant save failed")),
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Previous tenant save failed/)).toBeNull();
    client.clear();
  });
});
