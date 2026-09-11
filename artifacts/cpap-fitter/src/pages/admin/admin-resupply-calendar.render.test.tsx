// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  clearSessionCache,
  SessionMutationCache,
} from "@workspace/resupply-auth-react";
const { calendar, overview, queue, me } = vi.hoisted(() => ({
  calendar: vi.fn(),
  overview: vi.fn(),
  queue: vi.fn(),
  me: vi.fn(),
}));
vi.mock("@workspace/api-client-react/admin", () => ({
  useGetAdminMe: me,
  ApiError: class extends Error {},
}));
vi.mock("@/lib/admin/resupply-calendar-api", async () => ({
  ...(await vi.importActual("@/lib/admin/resupply-calendar-api")),
  getResupplyCalendar: calendar,
  getSupplyOverview: overview,
  queueResupplyOutreach: queue,
}));
import { AdminResupplyCalendarPage } from "./admin-resupply-calendar";
import { PatientSupplyOverview } from "@/components/admin/PatientSupplyOverview";
import {
  formatAppDate,
  parseAppDateTimeLocalInput,
  todayAppDateIso,
} from "@/lib/utils";
const date = parseAppDateTimeLocalInput(`${todayAppDateIso()}T12:00`)!;
const row = {
  id: "e1",
  patientId: "p1",
  patientName: "Jane Example",
  itemSku: "Mask",
  cadenceDays: 90,
  dueAt: date.toISOString(),
  status: "outreach_pending",
  hasPhone: true,
  hasEmail: true,
};
function mount(element = <AdminResupplyCalendarPage />) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  me.mockReturnValue({
    data: { permissions: ["patients.read", "conversations.manage"] },
  });
  calendar.mockResolvedValue({
    items: [
      row,
      { ...row, id: "e2", itemSku: "Tubing" },
      {
        ...row,
        id: "e3",
        patientId: "p2",
        patientName: "Sam Example",
        hasEmail: false,
      },
    ],
  });
  overview.mockResolvedValue({
    supplies: [],
    orders: [],
    totalOrders: 0,
    linkedOrders: [],
  });
  queue.mockResolvedValue({
    results: [
      { episodeId: "e1", status: "queued", message: "Queued for outreach." },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("CSR resupply workflow", () => {
  it("keeps the calendar readable without exposing outreach to read-only staff", async () => {
    me.mockReturnValue({ data: { permissions: ["patients.read"] } });
    mount();
    await screen.findByText("Jane Example");
    expect(screen.queryByRole("button", { name: "Email" })).toBeNull();
    expect(screen.queryByRole("button", { name: "SMS" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Automated call" })).toBeNull();
    expect(queue).not.toHaveBeenCalled();
  });
  it("groups supplies by patient and counts each patient once on a calendar day", async () => {
    mount();
    expect(
      await screen.findByText("2 patients · 3 supply cycles"),
    ).toBeTruthy();
    expect(screen.getAllByLabelText("Select Jane Example")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: `${formatAppDate(date)}, 2 patients due`,
      }),
    ).toBeTruthy();
  });
  it("clears selection when searching or switching the date window", async () => {
    mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select Jane Example"));
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("Search resupply patients or supplies"),
      { target: { value: "Sam" } },
    );
    expect(screen.getByText(/0 selected/)).toBeTruthy();
    expect(screen.queryByLabelText("Select Jane Example")).toBeNull();
    fireEvent.click(screen.getByLabelText("Select Sam Example"));
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText(/0 selected/)).toBeTruthy();
  });
  it("counts only search matches on each calendar day", async () => {
    mount();
    await screen.findByText("Jane Example");
    fireEvent.change(
      screen.getByLabelText("Search resupply patients or supplies"),
      {
        target: { value: "Tubing" },
      },
    );
    expect(screen.getByText("1 patients · 1 supply cycles")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `${formatAppDate(date)}, 1 patients due`,
      }),
    ).toBeTruthy();
  });
  it.each([
    [
      "2026-03-15T12:00:00Z",
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T04:00:00.000Z",
    ],
    [
      "2026-11-15T12:00:00Z",
      "2026-11-01T04:00:00.000Z",
      "2026-12-01T05:00:00.000Z",
    ],
  ])(
    "requests the practice's complete month across daylight-saving changes at %s",
    async (now, from, to) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      calendar.mockResolvedValue({ items: [] });
      mount();
      await waitFor(() =>
        expect(calendar).toHaveBeenCalledWith(from, to, false),
      );
    },
  );
  it("uses the displayed practice date for the current month and calendar day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T02:00:00Z"));
    calendar.mockResolvedValue({
      items: [{ ...row, dueAt: "2026-09-01T02:00:00Z" }],
    });
    mount();
    await screen.findByText("Jane Example");
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeTruthy();
    const dueDay = screen.getByRole("button", {
      name: "8/31/2026, 1 patients due",
    });
    fireEvent.click(dueDay);
    expect(screen.getByText("Jane Example")).toBeTruthy();
    expect(screen.getByText("· Aug 31, 2026")).toBeTruthy();
    expect(dueDay.getAttribute("aria-pressed")).toBe("true");
  });
  it("does not silently reselect a patient who disappears and returns after refresh", async () => {
    const { client } = mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select Jane Example"));
    calendar.mockResolvedValue({
      items: [
        { ...row, id: "e3", patientId: "p2", patientName: "Sam Example" },
      ],
    });
    await act(() =>
      client.refetchQueries({ queryKey: ["admin", "resupply-calendar"] }),
    );
    await waitFor(() => expect(screen.queryByText("Jane Example")).toBeNull());
    calendar.mockResolvedValue({ items: [row] });
    await act(() =>
      client.refetchQueries({ queryKey: ["admin", "resupply-calendar"] }),
    );
    expect(
      (
        (await screen.findByLabelText(
          "Select Jane Example",
        )) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.getByText(/^0 selected/)).toBeTruthy();
  });
  it.each([
    ["Email", "email"],
    ["SMS", "sms"],
    ["Automated call", "voice"],
  ] as const)(
    "reviews recipients before %s outreach and never submits duplicate supply rows",
    async (buttonName, channel) => {
      mount();
      await screen.findByText("Jane Example");
      fireEvent.click(screen.getByLabelText("Select Jane Example"));
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      expect(queue).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Queue outreach" }));
      await waitFor(() => expect(queue).toHaveBeenCalledWith(["e1"], channel));
      expect(
        await screen.findByText("1 queued · 0 skipped · 0 failed"),
      ).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: buttonName }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    },
  );
  it("opens order review directly from the calendar", async () => {
    mount();
    await screen.findByText("Jane Example");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Orders & eligibility" })[0]!,
    );
    expect(
      await screen.findByText("No supply orders recorded for this patient."),
    ).toBeTruthy();
    expect(overview).toHaveBeenCalledWith("p1", 0);
  });
  it("keeps bulk recipients selected while reviewing a patient's orders", async () => {
    mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select visible patients"));
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Orders & eligibility" })[0]!,
    );
    await screen.findByText("No supply orders recorded for this patient.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    expect(
      (screen.getByLabelText("Select Sam Example") as HTMLInputElement).checked,
    ).toBe(true);
  });
  it("uses the current time when refreshing the due-now queue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const initial = new Date("2026-09-11T12:00:00Z");
    const later = new Date("2026-09-11T13:00:00Z");
    vi.setSystemTime(initial);
    calendar.mockImplementation(async (from, _to, overdue) => ({
      items: overdue && Date.parse(from) >= later.getTime() ? [row] : [],
    }));
    const { client } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Due now & overdue" }));
    await waitFor(() =>
      expect(calendar).toHaveBeenCalledWith(
        initial.toISOString(),
        expect.any(String),
        true,
      ),
    );
    vi.setSystemTime(later);
    await act(() =>
      client.refetchQueries({
        queryKey: ["admin", "resupply-calendar", "due"],
      }),
    );
    expect(calendar).toHaveBeenLastCalledWith(
      later.toISOString(),
      expect.any(String),
      true,
    );
    expect(await screen.findByText("Jane Example")).toBeTruthy();
  });
  it("does not send an outreach confirmation opened before the session changed", async () => {
    const { client } = mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select Jane Example"));
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    await screen.findByRole("alertdialog");
    await act(() => clearSessionCache(client));
    fireEvent.click(screen.getByRole("button", { name: "Queue outreach" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(queue).not.toHaveBeenCalled();
  });
  it("can return to newer order history after an older-page failure", async () => {
    overview.mockImplementation(async (_patientId, offset) => {
      if (offset > 0) throw new Error("Older history unavailable");
      return {
        supplies: [],
        linkedOrders: [],
        totalOrders: 26,
        orders: [
          {
            id: "recent",
            itemSku: "MASK",
            itemName: "Recent mask",
            quantity: 1,
            status: "shipped",
            orderedAt: "2026-09-01T12:00:00Z",
          },
        ],
      };
    });
    mount(<PatientSupplyOverview patientId="p1" />);
    await screen.findByText("Recent mask");
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await screen.findByText("Older history unavailable");
    expect(screen.queryByRole("button", { name: "Newer" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    expect(await screen.findByText("Recent mask")).toBeTruthy();
  });
  it("keeps eligibility and order details readable while loading the next history page", async () => {
    let finish!: (value: unknown) => void;
    const nextPage = new Promise((resolve) => {
      finish = resolve;
    });
    const summary = {
      supplies: [
        {
          prescriptionId: "rx",
          itemSku: "MASK",
          itemName: "Current mask",
          cadenceDays: 90,
          eligibility: null,
        },
      ],
      linkedOrders: [],
      totalOrders: 26,
      orders: [
        {
          id: "recent",
          itemSku: "MASK",
          itemName: "Recent mask",
          quantity: 1,
          status: "shipped",
          orderedAt: "2026-09-01T12:00:00Z",
        },
      ],
    };
    overview.mockImplementation(async (_patientId, offset) =>
      offset ? nextPage : summary,
    );
    mount(<PatientSupplyOverview patientId="p1" />);
    await screen.findByText("Recent mask");
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(screen.getByText("Current mask")).toBeTruthy();
    expect(screen.getByText("Recent mask")).toBeTruthy();
    expect(screen.getByText("Loading order history…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Older" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Newer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      finish({
        ...summary,
        orders: [{ ...summary.orders[0], id: "older", itemName: "Older mask" }],
      });
    });
    expect(await screen.findByText("Older mask")).toBeTruthy();
    expect(screen.queryByText("Recent mask")).toBeNull();
    expect(screen.getByText("26–26 of 26")).toBeTruthy();
  });
  it("keeps newer-history recovery available when a refresh removes the last page", async () => {
    const summary = {
      supplies: [],
      linkedOrders: [],
      totalOrders: 26,
      orders: [
        {
          id: "o1",
          itemSku: "MASK",
          itemName: "Recorded mask",
          quantity: 1,
          status: "shipped",
          orderedAt: "2026-09-01T12:00:00Z",
        },
      ],
    };
    overview.mockResolvedValue(summary);
    const { client } = mount(<PatientSupplyOverview patientId="p1" />);
    await screen.findByText("Recorded mask");
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await screen.findByText("26–26 of 26");
    overview.mockImplementation(async (_patientId, offset) => ({
      ...summary,
      totalOrders: 25,
      orders: offset ? [] : summary.orders,
    }));
    await act(() =>
      client.refetchQueries({
        queryKey: ["admin", "supply-overview", "p1", 25],
      }),
    );
    await screen.findByText("25 recorded supply order lines · newest first");
    expect(
      screen.queryByText("No supply orders recorded for this patient."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    expect(await screen.findByText("Recorded mask")).toBeTruthy();
  });
  it("reports a calendar request failure and recovers through Retry", async () => {
    calendar.mockRejectedValueOnce(new Error("Calendar unavailable"));
    mount();
    expect(await screen.findByText("Calendar unavailable")).toBeTruthy();
    expect(
      screen.queryByText(
        "No active patients with scheduled resupply in this view.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Email" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Jane Example")).toBeTruthy();
  });
  it("filters by calendar day, clears selection, and returns to the whole month", async () => {
    const otherDay = new Date(date);
    otherDay.setUTCDate(date.getUTCDate() === 1 ? 2 : 1);
    calendar.mockResolvedValue({
      items: [
        row,
        {
          ...row,
          id: "e3",
          patientId: "p2",
          patientName: "Sam Example",
          dueAt: otherDay.toISOString(),
        },
      ],
    });
    mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select visible patients"));
    const dayButton = screen.getByRole("button", {
      name: `${formatAppDate(date)}, 1 patients due`,
    });
    fireEvent.click(dayButton);
    expect(dayButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Sam Example")).toBeNull();
    expect(screen.getByText(/0 selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show whole month" }));
    expect(screen.getByText("Sam Example")).toBeTruthy();
    expect(dayButton.getAttribute("aria-pressed")).toBe("false");
  });
  it("keeps skipped and failed bulk recipients available without requeueing successes", async () => {
    queue
      .mockResolvedValueOnce({
        results: [
          { episodeId: "e1", status: "queued", message: "Accepted Jane." },
          { episodeId: "e3", status: "error", message: "Sam needs retry." },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            episodeId: "e3",
            status: "skipped",
            message: "Sam was recently contacted.",
          },
        ],
      });
    mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select visible patients"));
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Queue outreach" }),
    );
    expect(
      await screen.findByText("1 queued · 0 skipped · 1 failed"),
    ).toBeTruthy();
    expect(screen.getByText("Sam Example: Sam needs retry.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SMS" }));
    const review = await screen.findByRole("alertdialog");
    expect(within(review).getByText("Sam Example")).toBeTruthy();
    expect(within(review).queryByText("Jane Example")).toBeNull();
    fireEvent.click(
      within(review).getByRole("button", { name: "Queue outreach" }),
    );
    await waitFor(() => expect(queue).toHaveBeenLastCalledWith(["e3"], "sms"));
    expect(
      await screen.findByText("0 queued · 1 skipped · 0 failed"),
    ).toBeTruthy();
  });
  it("limits bulk selection to 50 patients and allows cancellation without sending", async () => {
    calendar.mockResolvedValue({
      items: Array.from({ length: 51 }, (_, i) => ({
        ...row,
        id: `e${i}`,
        patientId: `p${i}`,
        patientName: `Patient ${i}`,
      })),
    });
    mount();
    await screen.findByText("Patient 50");
    fireEvent.click(screen.getByLabelText("Select visible patients"));
    expect(screen.getByText(/50 selected/)).toBeTruthy();
    const unchecked = screen
      .getAllByRole("checkbox")
      .filter((checkbox) => !(checkbox as HTMLInputElement).checked);
    expect(unchecked).toHaveLength(1);
    expect((unchecked[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    const review = await screen.findByRole("alertdialog");
    expect(within(review).getAllByRole("listitem")).toHaveLength(50);
    fireEvent.keyDown(review, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(queue).not.toHaveBeenCalled();
  });
  it("allows selecting current patients after a refresh removes a previously selected batch", async () => {
    const patients = (start: number) => ({
      items: Array.from({ length: 50 }, (_, i) => ({
        ...row,
        id: `e${start + i}`,
        patientId: `p${start + i}`,
        patientName: `Patient ${start + i}`,
      })),
    });
    calendar.mockResolvedValue(patients(0));
    const { client } = mount();
    await screen.findByText("Patient 0");
    fireEvent.click(screen.getByLabelText("Select visible patients"));
    expect(screen.getByText(/50 selected/)).toBeTruthy();
    calendar.mockResolvedValue(patients(50));
    await act(() =>
      client.refetchQueries({ queryKey: ["admin", "resupply-calendar"] }),
    );
    const nextPatient = (await screen.findByLabelText(
      "Select Patient 50",
    )) as HTMLInputElement;
    expect(screen.getByText(/^0 selected/)).toBeTruthy();
    expect(nextPatient.disabled).toBe(false);
    fireEvent.click(nextPatient);
    expect(nextPatient.checked).toBe(true);
    expect(screen.getByText(/1 selected/)).toBeTruthy();
  });
  it("shows exact order quantities, signature orders and unknown eligibility, and loads older history", async () => {
    overview.mockResolvedValue({
      supplies: [
        {
          prescriptionId: "rx",
          itemSku: "CUSTOM",
          itemName: "Custom mask",
          cadenceDays: 90,
          eligibility: null,
        },
      ],
      orders: [
        {
          id: "f1",
          itemSku: "CUSTOM",
          itemName: "Custom mask",
          quantity: 3,
          status: "shipped",
          orderedAt: "2026-08-01T12:00:00Z",
        },
      ],
      totalOrders: 26,
      linkedOrders: [
        {
          id: "csr",
          orderReference: "CSR-123",
          status: "sent",
          createdAt: "2026-09-01T12:00:00Z",
          items: [{ description: "Nasal pillows size M", quantity: 2 }],
        },
      ],
    });
    mount(<PatientSupplyOverview patientId="p1" />);
    expect(await screen.findByText("Needs eligibility review")).toBeTruthy();
    expect(screen.getByText("2 × Nasal pillows size M")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(overview).toHaveBeenCalledWith("p1", 25));
  });
});
