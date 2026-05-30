// @vitest-environment jsdom
//
// End-to-end render coverage for the reset-password page's 5xx
// "credentials store unreachable" alert. Complements the
// helper-level behavior test (auth-error-messaging.behavior.test.ts)
// by proving the actual page mounts the alert and uses the
// reset-password-specific action/subject.

import type { InputHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AuthError } from "@workspace/resupply-auth-react";

const mutateSpy = vi.fn();
vi.mock("@/lib/auth-hooks", () => ({
  authHooks: {
    useResetPassword: () => ({ mutate: mutateSpy, isPending: false }),
  },
}));

vi.mock("@/components/auth-layout", () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/password-input", () => ({
  PasswordInput: (
    props: InputHTMLAttributes<HTMLInputElement> & {
      inputTestId?: string;
      showStrength?: boolean;
      helperText?: string;
    },
  ) => {
    const { inputTestId, showStrength: _s, helperText: _h, ...rest } = props;
    return <input type="password" data-testid={inputTestId} {...rest} />;
  },
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/reset-password", vi.fn()] as const,
  };
});

import { ResetPasswordPage } from "./reset-password";

beforeEach(() => {
  mutateSpy.mockReset();
  cleanup();
  // The page reads ?token=… from window.location.search on mount and
  // disables the submit button when it's missing. Provide a token so
  // submit fires through to mutate().
  window.history.replaceState({}, "", "/reset-password?token=abc123");
});

function submitResetForm() {
  fireEvent.change(screen.getByTestId("reset-password-input"), {
    target: { value: "newpassword12345" },
  });
  fireEvent.change(screen.getByTestId("reset-confirm-password-input"), {
    target: { value: "newpassword12345" },
  });
  fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
}

describe("ResetPasswordPage — 5xx server-trouble alert renders into the DOM", () => {
  it("renders the credentials-store + status URL copy on a 503", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(503, "unknown", "ignored"));
    });

    render(<ResetPasswordPage />);
    submitResetForm();

    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toContain("credentials store");
    expect(alert.textContent ?? "").toContain("status.pennpaps.com");
    expect(alert.textContent ?? "").toContain("update your password");
  });

  it("renders the credentials-store copy on the 500 boundary too", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(500, "unknown", "ignored"));
    });

    render(<ResetPasswordPage />);
    submitResetForm();

    expect(screen.getByRole("alert").textContent ?? "").toContain(
      "credentials store",
    );
  });

  it("renders the server's verbatim message on a 4xx expired-link error", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(
        new AuthError(
          400,
          "unknown",
          "This reset link has expired. Request a new one.",
        ),
      );
    });

    render(<ResetPasswordPage />);
    submitResetForm();

    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("This reset link has expired.");
    expect(text).not.toContain("credentials store");
  });
});
