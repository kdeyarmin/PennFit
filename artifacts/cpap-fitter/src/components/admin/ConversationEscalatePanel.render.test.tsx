// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const {
  createCase,
  addCaseLink,
  createAdminPatientFollowup,
  createAdminCustomerFollowup,
  navigate,
} = vi.hoisted(() => ({
  createCase: vi.fn(),
  addCaseLink: vi.fn(),
  createAdminPatientFollowup: vi.fn(),
  createAdminCustomerFollowup: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/admin/conversations/x", navigate] as const,
}));
vi.mock("@/lib/admin/cases-api", () => ({ createCase, addCaseLink }));
vi.mock("@/lib/admin/patient-followups-api", () => ({
  createAdminPatientFollowup,
}));
vi.mock("@/lib/admin/customer-followups-api", () => ({
  createAdminCustomerFollowup,
}));

import { ConversationEscalatePanel } from "./ConversationEscalatePanel";

function renderPanel(
  props: Partial<{
    patientId: string | null;
    customerId: string | null;
  }> = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ConversationEscalatePanel
        conversationId="conv-1"
        patientId={"pat-1"}
        customerId={null}
        subjectLabel="Ada Lovelace"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("ConversationEscalatePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCase.mockResolvedValue({ id: "case-9", createdAt: "2026-01-01" });
    addCaseLink.mockResolvedValue({});
    createAdminPatientFollowup.mockResolvedValue({});
    createAdminCustomerFollowup.mockResolvedValue({});
  });
  afterEach(cleanup);

  it("opens a case, links the conversation, and navigates to it", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("escalate-open-case"));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/admin/cases?case=case-9"),
    );
    expect(createCase).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: "pat-1" }),
    );
    expect(addCaseLink).toHaveBeenCalledWith("case-9", {
      linkKind: "conversation",
      refId: "conv-1",
    });
  });

  it("schedules a patient follow-up for patient-flow threads", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("escalate-schedule-followup"));

    await waitFor(() => expect(createAdminPatientFollowup).toHaveBeenCalled());
    const [pid, body, dueAt] = createAdminPatientFollowup.mock.calls[0]!;
    expect(pid).toBe("pat-1");
    expect(body).toContain("Ada Lovelace");
    expect(dueAt).toBeInstanceOf(Date);
    expect(createAdminCustomerFollowup).not.toHaveBeenCalled();
  });

  it("schedules a customer follow-up for in-app (shop-customer) threads", async () => {
    renderPanel({ patientId: null, customerId: "cust-1" });
    fireEvent.click(screen.getByTestId("escalate-schedule-followup"));

    await waitFor(() => expect(createAdminCustomerFollowup).toHaveBeenCalled());
    expect(createAdminCustomerFollowup.mock.calls[0]![0]).toBe("cust-1");
    expect(createAdminPatientFollowup).not.toHaveBeenCalled();
  });
});
