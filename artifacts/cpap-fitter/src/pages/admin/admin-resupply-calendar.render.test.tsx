// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const { calendar, overview, queue, me } = vi.hoisted(() => ({
  calendar: vi.fn(),
  overview: vi.fn(),
  queue: vi.fn(),
  me: vi.fn(),
}));
vi.mock("@workspace/api-client-react/admin", () => ({ useGetAdminMe: me }));
vi.mock("@/lib/admin/resupply-calendar-api", async () => ({
  ...(await vi.importActual("@/lib/admin/resupply-calendar-api")),
  getResupplyCalendar: calendar,
  getSupplyOverview: overview,
  queueResupplyOutreach: queue,
}));
import { AdminResupplyCalendarPage } from "./admin-resupply-calendar";
import { PatientSupplyOverview } from "@/components/admin/PatientSupplyOverview";
const date = new Date();
date.setHours(12, 0, 0, 0);
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
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
afterEach(cleanup);
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
        name: `${date.toLocaleDateString()}, 2 patients due`,
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
  it("reviews named recipients before queueing and never submits duplicate supply rows", async () => {
    mount();
    await screen.findByText("Jane Example");
    fireEvent.click(screen.getByLabelText("Select Jane Example"));
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    expect(queue).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue outreach" }));
    await waitFor(() => expect(queue).toHaveBeenCalledWith(["e1"], "email"));
    expect(
      await screen.findByText("1 queued · 0 skipped · 0 failed"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Email" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
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
