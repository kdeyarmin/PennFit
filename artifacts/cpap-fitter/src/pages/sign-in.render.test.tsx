// @vitest-environment jsdom
//
// End-to-end render coverage for the customer sign-in page's 5xx
// "credentials store unreachable" alert. This complements the
// helper-level behavior test (auth-error-messaging.behavior.test.ts)
// by proving the real page actually mounts the alert into the DOM
// when the auth hook throws a 503 — catching regressions where the
// alert element is removed, hidden, or wrapped in a never-firing
// condition.

import type { InputHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AuthError } from "@workspace/resupply-auth-react";

// Mock the auth hooks module BEFORE importing the page. Each test
// rewires `mutate` to control onSuccess / onError synchronously.
const mutateSpy = vi.fn();
vi.mock("@/lib/auth-hooks", () => ({
  authHooks: {
    useSignIn: () => ({ mutate: mutateSpy, isPending: false }),
  },
}));

// AuthLayout pulls in a brand image via the `@assets/*` alias that
// only the vite build resolves. The tests don't care about chrome —
// stub it to a transparent pass-through wrapper.
vi.mock("@/components/auth-layout", () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
// PasswordInput is a fancy show/hide field — for tests we only need
// a plain <input> wired by id/testid so the queries still match.
vi.mock("@/components/password-input", () => ({
  PasswordInput: (
    props: InputHTMLAttributes<HTMLInputElement> & { inputTestId?: string },
  ) => {
    const { inputTestId, ...rest } = props;
    return <input type="password" data-testid={inputTestId} {...rest} />;
  },
}));

// Stub wouter's useLocation so post-submit navigation in onSuccess
// doesn't actually try to navigate (and so we don't need a Router).
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/sign-in", vi.fn()] as const,
  };
});

import { SignInPage } from "./sign-in";

beforeEach(() => {
  mutateSpy.mockReset();
  cleanup();
});

function submitSignInForm() {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByTestId("signin-password-input"), {
    target: { value: "hunter22hunter22" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("SignInPage — 5xx server-trouble alert renders into the DOM", () => {
  it("renders the credentials-store + status URL copy on a 503", () => {
    // Drive onError synchronously with a real AuthError(503).
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(503, "unknown", "ignored server message"));
    });

    render(<SignInPage />);
    submitSignInForm();

    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toContain("credentials store");
    expect(alert.textContent ?? "").toContain("status.pennpaps.com");
    // The action verb proves the page-specific options reached the
    // helper — i.e. the page didn't accidentally call the helper
    // with a generic default.
    expect(alert.textContent ?? "").toContain("sign you in");
  });

  it("renders the credentials-store copy on the 500 boundary too", () => {
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(new AuthError(500, "unknown", "ignored"));
    });

    render(<SignInPage />);
    submitSignInForm();

    expect(screen.getByRole("alert").textContent ?? "").toContain(
      "credentials store",
    );
  });

  it("renders the server's verbatim message on a 401 credential error", () => {
    // A 4xx must NOT mention the credentials store — that would
    // mislead the user into blaming the system when their password
    // was actually wrong.
    mutateSpy.mockImplementation((_vars, opts) => {
      opts.onError(
        new AuthError(
          401,
          "invalid_credentials",
          "Email or password is incorrect.",
        ),
      );
    });

    render(<SignInPage />);
    submitSignInForm();

    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("Email or password is incorrect.");
    expect(text).not.toContain("credentials store");
    expect(text).not.toContain("status.pennpaps.com");
  });

  it("does not render any alert before the form is submitted", () => {
    render(<SignInPage />);
    // The role=alert region is conditionally mounted — guards against
    // a regression where the alert renders on first paint with stale
    // state.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
