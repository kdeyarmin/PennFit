// @vitest-environment jsdom
//
// Render regression test for AdminFitterFollowupsPage
// (/admin/fitter-followups).
//
// The bug this pins: the staff-note textarea seeds its draft from
// `row.staffNote` with `useState`, and the rows are keyed by id — so
// React keeps each AlertRow mounted across refetches and that initial
// value is read exactly ONCE. In a queue several CSRs work at the same
// time, a note somebody else saved would therefore never appear here,
// and blurring the field would push the value captured at mount back
// over theirs — a silent revert of another person's edit, with no error
// and no trace.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { api } = vi.hoisted(() => ({
  api: {
    listFitterFollowupAlerts: vi.fn(),
    updateFitterFollowupAlert: vi.fn(),
  },
}));

vi.mock("@/lib/admin/fitter-followup-alerts-api", () => ({
  listFitterFollowupAlerts: api.listFitterFollowupAlerts,
  updateFitterFollowupAlert: api.updateFitterFollowupAlert,
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/admin/use-document-title", () => ({
  useDocumentTitle: () => undefined,
}));

import { AdminFitterFollowupsPage } from "./admin-fitter-followups";

const ALERT_ID = "66666666-6666-4666-8666-666666666666";

function alertRow(staffNote: string | null) {
  return {
    id: ALERT_ID,
    alertType: "fit_no_request",
    severity: "high",
    status: "open",
    fitterInviteId: "77777777-7777-4777-8777-777777777777",
    fitRequestId: null,
    fitSessionId: null,
    patientId: null,
    detail: {},
    nudgeCount: 1,
    lastNudgeAt: "2026-06-07T00:00:00.000Z",
    lastNudgeChannel: "email",
    resolvedAt: null,
    resolvedReason: null,
    dismissedAt: null,
    dismissedByEmail: null,
    staffNote,
    createdAt: "2026-06-06T00:00:00.000Z",
    contact: {
      name: "Jordan Avery",
      email: "jordan@example.com",
      phone: "+12155550137",
      preferredMethod: "email",
      preferredTime: null,
    },
    inviteStatus: "completed",
    inviteChannel: "email",
    inviteExpiresAt: null,
    recommendedMaskName: "ResMed AirFit P30i",
    fittingCompletedAt: "2026-06-04T00:00:00.000Z",
    linkSentAt: "2026-05-28T00:00:00.000Z",
    requestStatus: null,
    requestType: null,
    requestCreatedAt: null,
  };
}

function payload(staffNote: string | null) {
  return {
    alerts: [alertRow(staffNote)],
    counts: {
      fit_not_started: 0,
      fit_abandoned: 0,
      fit_no_request: 1,
      request_unworked: 0,
    },
    openTotal: 1,
    openHigh: 1,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminFitterFollowupsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the staff note does not revert another CSR's edit", () => {
  it("shows a note saved elsewhere once the row refetches", async () => {
    api.listFitterFollowupAlerts
      .mockResolvedValueOnce(payload("left a voicemail"))
      .mockResolvedValue(payload("spoke to them, ordering Monday"));

    renderPage();
    const note = (await screen.findByTestId(
      `fitter-followup-note-${ALERT_ID}`,
    )) as HTMLTextAreaElement;
    expect(note.value).toBe("left a voicemail");

    // A second CSR saved a different note; this client refetches.
    fireEvent.click(screen.getByTestId("fitter-followups-refresh"));

    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            `fitter-followup-note-${ALERT_ID}`,
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("spoke to them, ordering Monday"),
    );
  });

  it("does not PATCH the stale value back on blur after that refetch", async () => {
    api.listFitterFollowupAlerts
      .mockResolvedValueOnce(payload("left a voicemail"))
      .mockResolvedValue(payload("spoke to them, ordering Monday"));

    renderPage();
    await screen.findByTestId(`fitter-followup-note-${ALERT_ID}`);
    fireEvent.click(screen.getByTestId("fitter-followups-refresh"));
    await waitFor(() =>
      expect(
        (
          screen.getByTestId(
            `fitter-followup-note-${ALERT_ID}`,
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("spoke to them, ordering Monday"),
    );

    // Blurring without editing must be a no-op — this is the write that
    // used to silently overwrite the other CSR's note.
    fireEvent.blur(screen.getByTestId(`fitter-followup-note-${ALERT_ID}`));
    expect(api.updateFitterFollowupAlert).not.toHaveBeenCalled();
  });

  it("still sends an edit the CSR actually typed", async () => {
    api.listFitterFollowupAlerts.mockResolvedValue(payload("left a voicemail"));
    api.updateFitterFollowupAlert.mockResolvedValue({
      alert: alertRow("called again"),
    });

    renderPage();
    const note = await screen.findByTestId(`fitter-followup-note-${ALERT_ID}`);
    fireEvent.change(note, { target: { value: "called again" } });
    fireEvent.blur(note);

    await waitFor(() =>
      expect(api.updateFitterFollowupAlert).toHaveBeenCalledWith(ALERT_ID, {
        staffNote: "called again",
      }),
    );
  });
});

describe("an already-dead link says so", () => {
  it("does not claim a long-expired link 'expires today'", async () => {
    // A cohort-A alert stays open until the patient acts, which includes
    // long after the invite itself expires. Clamping the countdown at
    // zero pointed staff at a dead link forever instead of a resend.
    api.listFitterFollowupAlerts.mockResolvedValue({
      ...payload(null),
      alerts: [
        {
          ...alertRow(null),
          alertType: "fit_not_started",
          severity: "medium",
          inviteExpiresAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    renderPage();
    expect(await screen.findByText(/link has expired/)).toBeTruthy();
    expect(screen.queryByText(/expires today/)).toBeNull();
  });

  it("still counts down a link that is alive", async () => {
    // Plus an hour: the page reads its own `Date.now()` a moment after
    // this line, and a flat 5 days would floor to 4.
    const future = new Date(
      Date.now() + 5 * 86_400_000 + 3_600_000,
    ).toISOString();
    api.listFitterFollowupAlerts.mockResolvedValue({
      ...payload(null),
      alerts: [
        {
          ...alertRow(null),
          alertType: "fit_not_started",
          severity: "medium",
          inviteExpiresAt: future,
        },
      ],
    });
    renderPage();
    expect(await screen.findByText(/works for 5 more day/)).toBeTruthy();
  });
});

describe("the row tells a CSR how to reach this person", () => {
  it("renders the contact preference", async () => {
    api.listFitterFollowupAlerts.mockResolvedValue(payload(null));
    renderPage();
    expect(await screen.findByText(/Contacted by email/)).toBeTruthy();
  });
});
