// @vitest-environment jsdom
//
// Render tests for the Home page's one-line fitter-invite sender. The
// point of the card is that a CSR never picks a channel: what they type
// decides it. These assert exactly that — the button label and the POST
// body follow the typed contact — plus the two states that used to send
// people hunting: a soft delivery failure still hands over a link, and
// the in-office path needs no contact at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const { createFitterInvite } = vi.hoisted(() => ({
  createFitterInvite: vi.fn(),
}));

vi.mock("@/lib/admin/fitter-invites-api", () => ({ createFitterInvite }));

// The card only uses the client to invalidate the worklist query.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// wouter's <Link/> needs a router in context; the href is all we assert.
vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Canvas isn't implemented in jsdom, so the QR renderer would throw.
vi.mock("@/components/QrCode", () => ({
  QrCode: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value} />
  ),
}));

import { FitterInviteQuickSend } from "./FitterInviteQuickSend";

const OK = {
  id: "inv-1",
  channel: "sms" as const,
  delivered: true,
  deliveryError: null,
  inviteLink: "https://pennpaps.com/fitter-invite?t=abc",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function typeContact(value: string) {
  fireEvent.change(screen.getByLabelText(/mobile number or email/i), {
    target: { value },
  });
}

beforeEach(() => {
  createFitterInvite.mockReset();
  createFitterInvite.mockResolvedValue(OK);
});
afterEach(() => cleanup());

describe("FitterInviteQuickSend", () => {
  it("infers SMS from a typed phone number and sends E.164", async () => {
    render(<FitterInviteQuickSend />);
    typeContact("(215) 555-1234");

    expect(screen.getByText("Will text (215) 555-1234.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));

    await waitFor(() => expect(createFitterInvite).toHaveBeenCalledTimes(1));
    expect(createFitterInvite).toHaveBeenCalledWith({
      channel: "sms",
      phoneE164: "+12155551234",
    });
    expect(
      await screen.findByText(/Texted the fitting link to \(215\) 555-1234\./),
    ).toBeTruthy();
  });

  it("infers email from a typed address and passes the optional name", async () => {
    render(<FitterInviteQuickSend />);
    typeContact("Jordan@Example.com");
    fireEvent.change(screen.getByLabelText(/first name/i), {
      target: { value: "  Jordan  " },
    });

    expect(screen.getByRole("button", { name: "Send email" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));

    await waitFor(() => expect(createFitterInvite).toHaveBeenCalledTimes(1));
    expect(createFitterInvite).toHaveBeenCalledWith({
      channel: "email",
      email: "jordan@example.com",
      name: "Jordan",
    });
  });

  it("refuses to send an unusable contact and says why, without a request", () => {
    render(<FitterInviteQuickSend />);
    typeContact("555-1234");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(createFitterInvite).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(
      /10-digit mobile number or an email address/i,
    );
  });

  it("creates an in-office QR with no contact typed at all", async () => {
    createFitterInvite.mockResolvedValue({ ...OK, channel: "in_office" });
    render(<FitterInviteQuickSend />);

    fireEvent.click(screen.getByRole("button", { name: /show a QR code/i }));

    await waitFor(() => expect(createFitterInvite).toHaveBeenCalledTimes(1));
    expect(createFitterInvite).toHaveBeenCalledWith({ channel: "in_office" });
    expect((await screen.findByTestId("qr-code")).dataset.value).toBe(
      OK.inviteLink,
    );
  });

  it("still hands over the link when automatic delivery is not configured", async () => {
    createFitterInvite.mockResolvedValue({
      ...OK,
      delivered: false,
      deliveryError: "no_sms_config",
    });
    render(<FitterInviteQuickSend />);
    typeContact("2155551234");
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));

    expect(
      await screen.findByText(/couldn't send it automatically/i),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("textbox", { name: /invite link/i })
        .getAttribute("value"),
    ).toBe(OK.inviteLink);
  });

  it("surfaces the API's message when the send fails", async () => {
    createFitterInvite.mockRejectedValue(
      new Error("You're sending fitter invites too quickly."),
    );
    render(<FitterInviteQuickSend />);
    typeContact("jordan@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));

    expect(
      await screen.findByText(/sending fitter invites too quickly/i),
    ).toBeTruthy();
  });
});
