// @vitest-environment jsdom
//
// Behavioural cover for /fit-request — the page that replaced the
// fitter's self-serve order form.
//
// What is worth pinning:
//   * The two modes ask for genuinely different things. A callback
//     request must not demand insurance details; that is the whole
//     reason the mode exists.
//   * Insurance is OPTIONAL in the detailed mode too, but a member ID
//     with no carrier (or the reverse) is a half-answer that reads as
//     complete on the queue, so the form asks for the pair or neither.
//   * A FAILED submission says so. The patient has no order number to
//     chase a lost request with, so a thank-you page over a dropped
//     write is worse than an error.

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

const setLocation = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/fit-request", setLocation],
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-document-title", () => ({ useDocumentTitle: vi.fn() }));
vi.mock("@/lib/contact", () => ({
  useCompanyContact: () => ({
    name: "Penn Home Medical Supply",
    legalName: "Penn Home Medical Supply",
    phoneE164: null,
    phoneDisplay: null,
  }),
}));

const submitFitRequest = vi.fn();
vi.mock("@/lib/fit-request-api", () => ({
  submitFitRequest: (...args: unknown[]) => submitFitRequest(...args),
}));

const store = {
  chosenMask: {
    maskId: "resmed-airfit-f20",
    name: "AirFit F20",
    modelNumber: "PHM-RM-F20",
    manufacturer: "ResMed",
    size: "M",
    maskType: "fullFace",
  } as Record<string, unknown> | null,
  population: "adult" as "adult" | "pediatric" | null,
  fitSessionId: "session-1" as string | null,
  inviteToken: "tok" as string | null,
};
vi.mock("@/hooks/use-fitter-store", () => ({
  useFitterStore: () => ({
    chosenMask: store.chosenMask,
    setChosenMask: (v: unknown) => {
      store.chosenMask = v as Record<string, unknown> | null;
    },
    email: "alice@example.com",
    population: store.population,
    inviteToken: store.inviteToken,
    fitSessionId: store.fitSessionId,
  }),
}));

import { FitRequest } from "./fit-request";

function setMode(mode: "full_details" | "callback") {
  const search = mode === "callback" ? "?mode=callback" : "";
  window.history.replaceState({}, "", `/fit-request${search}`);
}

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
  fireEvent.blur(screen.getByTestId(testId));
}

beforeEach(() => {
  cleanup();
  setLocation.mockReset();
  submitFitRequest.mockReset();
  submitFitRequest.mockResolvedValue({
    kind: "filed",
    confirmationEmailed: true,
  });
  store.chosenMask = {
    maskId: "resmed-airfit-f20",
    name: "AirFit F20",
    modelNumber: "PHM-RM-F20",
    manufacturer: "ResMed",
    size: "M",
    maskType: "fullFace",
  };
  store.population = "adult";
  store.fitSessionId = "session-1";
  store.inviteToken = "tok";
  setMode("full_details");
});

describe("fit-request — the two modes ask for different things", () => {
  it("asks for insurance in the detailed mode", () => {
    render(<FitRequest />);
    expect(screen.getByTestId("input-fit-request-carrier")).toBeTruthy();
    expect(screen.getByTestId("input-fit-request-member-id")).toBeTruthy();
  });

  it("asks for NOTHING but contact details in callback mode", () => {
    // The mode exists so a patient who can't find their member ID is not
    // stuck. Rendering the insurance block here would defeat that.
    setMode("callback");
    render(<FitRequest />);
    expect(screen.queryByTestId("input-fit-request-carrier")).toBeNull();
    expect(screen.queryByTestId("input-fit-request-member-id")).toBeNull();
    expect(screen.queryByTestId("input-fit-request-dob")).toBeNull();
    expect(screen.getByTestId("input-fit-request-name")).toBeTruthy();
    expect(screen.getByTestId("input-fit-request-phone")).toBeTruthy();
  });

  it("shows the mask the fitting matched, when there is one", () => {
    render(<FitRequest />);
    expect(screen.getByTestId("fit-request-mask").textContent).toContain(
      "AirFit F20",
    );
  });

  it("renders without a chosen mask — the callback path never requires one", () => {
    store.chosenMask = null;
    setMode("callback");
    render(<FitRequest />);
    expect(screen.queryByTestId("fit-request-mask")).toBeNull();
    expect(screen.getByTestId("button-fit-request-submit")).toBeTruthy();
  });
});

describe("fit-request — submission", () => {
  it("files a callback request with the fitting context attached", async () => {
    setMode("callback");
    render(<FitRequest />);
    fill("input-fit-request-name", "Alice Nguyen");
    fill("input-fit-request-phone", "5551234567");
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));

    await waitFor(() => expect(submitFitRequest).toHaveBeenCalledTimes(1));
    expect(submitFitRequest.mock.calls[0]?.[0]).toMatchObject({
      requestType: "callback",
      fullName: "Alice Nguyen",
      email: "alice@example.com",
      population: "adult",
      fitSessionId: "session-1",
      recommendedMaskName: "AirFit F20",
      recommendedMaskSize: "M",
    });
  });

  it("carries the pediatric service line onto the request", async () => {
    store.population = "pediatric";
    setMode("callback");
    render(<FitRequest />);
    fill("input-fit-request-name", "Sam Q");
    fill("input-fit-request-phone", "5551234567");
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));
    await waitFor(() => expect(submitFitRequest).toHaveBeenCalledTimes(1));
    expect(submitFitRequest.mock.calls[0]?.[0]).toMatchObject({
      population: "pediatric",
    });
  });

  it("confirms WITHOUT an order number", async () => {
    // An order-shaped reference for something nobody has looked at yet
    // sets exactly the wrong expectation.
    setMode("callback");
    render(<FitRequest />);
    fill("input-fit-request-name", "Alice Nguyen");
    fill("input-fit-request-phone", "5551234567");
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));

    await waitFor(() =>
      expect(screen.getByText(/We have your request/i)).toBeTruthy(),
    );
    expect(screen.getByText(/Nothing has been ordered/i)).toBeTruthy();
    expect(screen.queryByText(/order (number|reference)/i)).toBeNull();
  });

  it("says so when the request could NOT be filed", async () => {
    submitFitRequest.mockResolvedValue({
      kind: "failed",
      message: "We couldn't send that just now.",
    });
    setMode("callback");
    render(<FitRequest />);
    fill("input-fit-request-name", "Alice Nguyen");
    fill("input-fit-request-phone", "5551234567");
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("fit-request-error")).toBeTruthy(),
    );
    expect(screen.queryByText(/We have your request/i)).toBeNull();
  });

  it("refuses to submit a half-filled insurance pair", async () => {
    // A member ID with no carrier reads as complete on the queue and
    // isn't — so the form asks for the pair or neither.
    render(<FitRequest />);
    fill("input-fit-request-name", "Alice Nguyen");
    fill("input-fit-request-phone", "5551234567");
    fill("input-fit-request-member-id", "HM12345");
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));

    await waitFor(() =>
      expect(
        screen.getByText(/carrier that issued this member ID/i),
      ).toBeTruthy(),
    );
    expect(submitFitRequest).not.toHaveBeenCalled();
  });

  it("accepts a detailed request with NO insurance at all", async () => {
    render(<FitRequest />);
    fill("input-fit-request-name", "Alice Nguyen");
    fill("input-fit-request-phone", "5551234567");
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));
    await waitFor(() => expect(submitFitRequest).toHaveBeenCalledTimes(1));
    expect(submitFitRequest.mock.calls[0]?.[0]).toMatchObject({
      requestType: "full_details",
    });
  });
});

describe("fit-request — honeypot is autofill-proof", () => {
  it("renders the trap read-only so password managers skip it", () => {
    // Browser autofill ignores autoComplete="off" and fills hidden
    // inputs; a tripped honeypot shows a REAL patient a fake success
    // screen with no request ever filed. Read-only fields are skipped
    // by every autofill engine, while no human can focus the off-screen
    // input to release it.
    render(<FitRequest />);
    const trap = document.getElementById(
      "fit-request-website",
    ) as HTMLInputElement;
    expect(trap).toBeTruthy();
    expect(trap.readOnly).toBe(true);
    // A bot that focuses the field (simulated typing) still releases
    // the trap and gets caught by the value check on submit.
    fireEvent.focus(trap);
    expect(trap.readOnly).toBe(false);
  });

  it("a filled trap still short-circuits with a fake success and no API call", async () => {
    render(<FitRequest />);
    fill("input-fit-request-name", "Alice Nguyen");
    fill("input-fit-request-phone", "5551234567");
    const trap = document.getElementById(
      "fit-request-website",
    ) as HTMLInputElement;
    fireEvent.focus(trap);
    fireEvent.change(trap, { target: { value: "http://spam.example" } });
    fireEvent.click(screen.getByTestId("button-fit-request-submit"));

    await waitFor(() =>
      expect(screen.getByText(/We have your request/i)).toBeTruthy(),
    );
    expect(submitFitRequest).not.toHaveBeenCalled();
  });
});
