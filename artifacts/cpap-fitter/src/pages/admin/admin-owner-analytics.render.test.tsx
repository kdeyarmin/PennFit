// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearSessionCache } from "@workspace/resupply-auth-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOwnerAnalytics,
  type OwnerAnalyticsResponse,
} from "@/lib/admin/owner-analytics-api";
import { ownerAnalyticsFixture as fixture } from "./owner-analytics.fixture";
import { AdminOwnerAnalyticsPage } from "./admin-owner-analytics";

const auth = vi.hoisted(() => ({
  userId: "owner-one",
  permissions: ["metrics.read", "cost.read"],
  isPending: false,
  error: null as Error | null,
}));
vi.mock("@workspace/api-client-react/admin", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react/admin")>()),
  useGetAdminMe: () => ({
    data: { userId: auth.userId, permissions: auth.permissions },
    isPending: auth.isPending,
    error: auth.error,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/admin/owner-analytics-api", () => ({
  fetchOwnerAnalytics: vi.fn(),
}));

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AdminOwnerAnalyticsPage />
      </QueryClientProvider>,
    ),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  auth.userId = "owner-one";
  auth.permissions = ["metrics.read", "cost.read"];
  auth.isPending = false;
  auth.error = null;
  vi.mocked(fetchOwnerAnalytics).mockResolvedValue(fixture());
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:overview"),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Owner overview", () => {
  it.each([["cost.read"], ["metrics.read"], ["reports.read"]])(
    "does not request financial data without both permissions: %j",
    async (permissions) => {
      auth.permissions = permissions;
      mount();
      expect(screen.getByRole("alert").textContent).toContain(
        "requires management and financial reporting access",
      );
      expect(fetchOwnerAnalytics).not.toHaveBeenCalled();
    },
  );
  it("waits for authorization before requesting the overview", () => {
    auth.isPending = true;
    mount();
    expect(fetchOwnerAnalytics).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Owner overview" }),
    ).toBeNull();
  });
  it("shows period comparisons, distinct lifetime coverage and accessible exact chart values", async () => {
    mount();
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    expect(fetchOwnerAnalytics).toHaveBeenCalledWith(
      { days: 30 },
      expect.any(AbortSignal),
    );
    const navigation = screen.getByRole("navigation", {
      name: "Overview sections",
    });
    for (const [label, heading, id] of [
      ["Claims", "Claims & payer activity", "claims"],
      ["Products & stock", "Products & fulfillment", "products"],
      ["Outreach", "Outreach & patient response", "outreach"],
    ]) {
      expect(
        within(navigation)
          .getByRole("link", { name: label })
          .getAttribute("href"),
      ).toBe(`#${id}`);
      expect(screen.getByRole("region", { name: heading }).id).toBe(id);
    }
    const financial = screen.getByRole("region", {
      name: "Recorded financial activity",
    });
    expect(financial.textContent).toContain("$100.00");
    expect(financial.textContent).toContain("Previous $80.00 (+$20.00)");
    const lifetime = screen.getByRole("region", {
      name: "Completed-review contribution",
    });
    expect(lifetime.textContent).toContain("Lifetime");
    expect(lifetime.textContent).toContain("coverage 40.0%");
    expect(lifetime.textContent).toContain("3 incomplete reviews are excluded");
    fireEvent.click(
      within(financial).getByRole("button", { name: "Show data table" }),
    );
    const table = within(financial).getByRole("table", {
      name: "Recorded revenue and cost trend data",
    });
    expect(table.textContent).toContain("2026-09-14");
    expect(table.textContent).toContain("$60.00");
    expect(
      screen
        .getByRole("link", { name: /Open team inbox/ })
        .getAttribute("href"),
    ).toBe("/admin/conversations");
  });
  it("keeps available business results and exports while financial data is unavailable; retry recovers", async () => {
    const partial = fixture();
    partial.financial = {
      status: "unavailable",
      message: "Financial records could not be loaded.",
    };
    vi.mocked(fetchOwnerAnalytics).mockResolvedValueOnce(partial);
    mount();
    await screen.findByRole("heading", {
      name: "Financial activity unavailable",
    });
    expect(
      screen.getByRole("heading", { name: "Patients & order activity" }),
    ).toBeTruthy();
    expect(screen.queryByText("Recorded revenue activity")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Download overview CSV" }),
    );
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as NodeBlob;
    const csv = await blob.text();
    expect(csv).toContain(
      '"Business","Selected period","Patients Added","12",',
    );
    expect(csv).toContain("Financial records could not be loaded.");
    expect(csv).not.toContain('"Financial","Recorded revenue');
    fireEvent.click(
      screen.getByRole("button", { name: "Retry financial activity" }),
    );
    await screen.findByRole("heading", { name: "Recorded financial activity" });
  });
  it("downloads period totals separately from lifetime contribution with source scopes", async () => {
    mount();
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    fireEvent.click(
      screen.getByRole("button", { name: "Download overview CSV" }),
    );
    const csv = await (
      vi.mocked(URL.createObjectURL).mock.calls[0][0] as NodeBlob
    ).text();
    expect(csv).toContain(
      '"Financial","Recorded revenue and cost events in period","Revenue","100.00","80.00","USD"',
    );
    expect(csv).toContain(
      '"Financial","Lifetime bound reviews; contribution only completed reviews","Contribution","200.00","","USD"',
    );
    expect(csv).toContain('"Business","Selected period","Units prepared","14"');
    expect(csv).toContain("Top 10 products by units shipped in period");
    expect(csv).toContain("Current status of claims created in period");
    expect(csv).toContain("2026-09-14T12:00:00.000Z");
  });
  it("does not export or invent zero totals when both sections are unavailable", async () => {
    const unavailable = fixture();
    unavailable.business = {
      status: "unavailable",
      message: "Business source unavailable.",
    };
    unavailable.financial = {
      status: "unavailable",
      message: "Financial source unavailable.",
    };
    vi.mocked(fetchOwnerAnalytics).mockResolvedValueOnce(unavailable);
    mount();
    await screen.findByRole("heading", {
      name: "Business activity unavailable",
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Download overview CSV",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText("$0.00")).toBeNull();
    const navigation = screen.getByRole("navigation", {
      name: "Overview sections",
    });
    expect(
      within(navigation).queryByRole("link", { name: "Claims" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", { name: "Products & stock" }),
    ).toBeNull();
    expect(
      within(navigation).queryByRole("link", { name: "Outreach" }),
    ).toBeNull();
    expect(
      screen.getByText(
        "Priority queues are unavailable until a report section loads.",
      ),
    ).toBeTruthy();
  });
  it("blocks export during refresh and does not present old data as successful after refresh fails", async () => {
    const pending = deferred<OwnerAnalyticsResponse>();
    mount();
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    vi.mocked(fetchOwnerAnalytics).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Download overview CSV" }),
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Download overview CSV",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    await act(async () => pending.reject(new Error("Report interrupted")));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Recorded financial activity" }),
      ).toBeNull(),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Download overview CSV",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("requires valid applied custom dates and hides old results while dates are edited", async () => {
    mount();
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Reporting period" }),
      {
        target: { value: "custom" },
      },
    );
    fireEvent.change(screen.getByLabelText("Start date (UTC)"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText("End date (UTC)"), {
      target: { value: "2026-05-01" },
    });
    expect(screen.getByRole("alert").textContent).toContain("End date must be");
    expect(fetchOwnerAnalytics).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("heading", { name: "Recorded financial activity" }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("End date (UTC)"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    expect(fetchOwnerAnalytics).toHaveBeenLastCalledWith(
      { from: "2026-06-01", to: "2026-06-30" },
      expect.any(AbortSignal),
    );
    fireEvent.change(screen.getByLabelText("End date (UTC)"), {
      target: { value: "2026-07-01" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Download overview CSV",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("never replaces the selected period with a late response for an earlier period", async () => {
    const old = deferred<OwnerAnalyticsResponse>();
    vi.mocked(fetchOwnerAnalytics).mockReturnValueOnce(old.promise);
    mount();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Reporting period" }),
      {
        target: { value: "7" },
      },
    );
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    const stale = fixture();
    if (stale.financial.status === "available")
      stale.financial.data.current.revenueCents = 999999;
    await act(async () => old.resolve(stale));
    expect(screen.queryByText("$9,999.99")).toBeNull();
    expect(fetchOwnerAnalytics).toHaveBeenLastCalledWith(
      { days: 7 },
      expect.any(AbortSignal),
    );
  });
  it("does not export a previously rendered report after the shared session changes", async () => {
    const { client } = mount();
    await screen.findByRole("heading", { name: "Recorded financial activity" });
    const button = screen.getByRole("button", {
      name: "Download overview CSV",
    });
    await act(async () => {
      await clearSessionCache(client);
      fireEvent.click(button);
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("does not refill the cleared cache from a late account response", async () => {
    const pending = deferred<OwnerAnalyticsResponse>();
    vi.mocked(fetchOwnerAnalytics).mockReturnValueOnce(pending.promise);
    const { client } = mount();
    await act(async () => {
      await clearSessionCache(client);
      pending.resolve(fixture());
    });
    expect(
      screen.queryByRole("heading", { name: "Recorded financial activity" }),
    ).toBeNull();
    expect(
      client.getQueryData(["admin", "analytics", "owner", { days: 30 }]),
    ).toBeUndefined();
  });
});
