// @vitest-environment jsdom
//
// End-to-end render coverage for the forgot-password page's
// no-enumeration contract:
//   * 5xx → visible "credentials store unreachable" alert
//   * 4xx (including the "no such account" case) → success view
//   * success → success view
//
// This complements the helper-level behavior test
// (auth-error-messaging.behavior.test.ts) by proving the page
// actually wires the decision helper to the DOM — that the alert
// element is mounted only when expected, and that the success view
// renders the "check your inbox" copy in both the happy path and
// the enumeration-shielded 4xx path.

import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AuthError } from "@workspace/resupply-auth-react";

const mutateSpy = vi.fn();
vi.mock("@/lib/auth-hooks", () => ({
  authHooks: {
    useForgotPassword: () => ({ mutate: mutateSpy, isPending: false }),
  },
}));

// AuthLayout pulls in a brand image via the `@assets/*` alias that
// only the vite build resolves — stub it to a pass-through wrapper.
vi.mock("@/components/auth-layout", () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ForgotPasswordPage } from "./forgot-password";

beforeEach(() => {
  mutateSpy.mockReset();
  cleanup();
});

function submitForgotForm() {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "user@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
}

// The success view's distinguishing copy — used to assert the page
// folded into "check your inbox" mode without leaking enumeration.
// Matched as a substring (the surrounding paragraph contains a
// typographic apostrophe and more sentence after it).
const SUCCESS_VIEW_COPY = /If an account exists for that email/;

describe("ForgotPasswordPage — visible 5xx alert", () => {
  it("renders the credentials-store + status URL alert on 503", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(503, "unknown", "ignored"));
    });

    render(<ForgotPasswordPage />);
    submitForgotForm();

    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toContain("credentials store");
    expect(alert.textContent ?? "").toContain("status.pennpaps.com");
    expect(alert.textContent ?? "").toContain("send a reset link");
    // 5xx path MUST NOT fold to the success view — the user needs
    // to know the email wasn't queued.
    expect(screen.queryByText(SUCCESS_VIEW_COPY)).toBeNull();
  });

  it("renders the credentials-store alert on the 500 boundary too", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(500, "unknown", "ignored"));
    });

    render(<ForgotPasswordPage />);
    submitForgotForm();

    expect(screen.getByRole("alert").textContent ?? "").toContain(
      "credentials store",
    );
  });
});

describe("ForgotPasswordPage — no-enumeration contract (4xx folds to success)", () => {
  it("4xx unknown-email AuthError folds to the success view", () => {
    // The contract: even if the server somehow returns a leaky 404
    // "no such account" body, the page must NOT distinguish it
    // visually from a successful send.
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(404, "unknown", "no such account"));
    });

    render(<ForgotPasswordPage />);
    submitForgotForm();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(SUCCESS_VIEW_COPY)).toBeTruthy();
  });

  it("4xx validation AuthError also folds to the success view", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(400, "unknown", "Email is required."));
    });

    render(<ForgotPasswordPage />);
    submitForgotForm();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(SUCCESS_VIEW_COPY)).toBeTruthy();
  });

  it("non-AuthError network failure folds to the success view", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new TypeError("fetch failed"));
    });

    render(<ForgotPasswordPage />);
    submitForgotForm();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(SUCCESS_VIEW_COPY)).toBeTruthy();
  });

  it("onSuccess renders the same success view", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onSuccess();
    });

    render(<ForgotPasswordPage />);
    submitForgotForm();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(SUCCESS_VIEW_COPY)).toBeTruthy();
  });
});
