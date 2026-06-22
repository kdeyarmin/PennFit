// @vitest-environment jsdom
//
// Inline email-format validation for the customer auth forms
// (sign-in / sign-up / forgot-password). Each surfaces a field-level
// aria-invalid + role="alert" error once the shopper types a malformed
// address, gates the submit button on it, and never round-trips an
// invalid address to the server. Mirrors the consent.tsx pattern.
//
// (No @testing-library/jest-dom in this project — assertions read the
// DOM directly, like the sibling *.render.test.tsx files.)

import type { InputHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { signInMutate, signUpMutate, forgotMutate } = vi.hoisted(() => ({
  signInMutate: vi.fn(),
  signUpMutate: vi.fn(),
  forgotMutate: vi.fn(),
}));

vi.mock("@/lib/auth-hooks", () => ({
  authHooks: {
    useSignIn: () => ({ mutate: signInMutate, isPending: false }),
    useSignUp: () => ({ mutate: signUpMutate, isPending: false }),
    useForgotPassword: () => ({ mutate: forgotMutate, isPending: false }),
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
    const { inputTestId, showStrength, helperText, ...rest } = props;
    void showStrength;
    void helperText;
    return <input type="password" data-testid={inputTestId} {...rest} />;
  },
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/sign-in", vi.fn()] as const,
    Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  };
});

import { SignInPage } from "./sign-in";
import { SignUpPage } from "./sign-up";
import { ForgotPasswordPage } from "./forgot-password";

beforeEach(() => {
  signInMutate.mockReset();
  signUpMutate.mockReset();
  forgotMutate.mockReset();
  cleanup();
});

function emailInput(): HTMLInputElement {
  return screen.getByLabelText("Email") as HTMLInputElement;
}

describe("SignInPage — inline email validation", () => {
  it("flags a malformed email with aria-invalid + a linked alert", () => {
    render(<SignInPage />);
    const input = emailInput();
    // Nothing typed → no error.
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(input, { target: { value: "not-an-email" } });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toMatch(/valid email address/i);
    // aria-describedby points at the alert's id so screen readers
    // announce the error when the field is focused.
    expect(alert.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("does not submit (no server round-trip) while the email is invalid", () => {
    render(<SignInPage />);
    fireEvent.change(emailInput(), { target: { value: "bad" } });
    fireEvent.change(screen.getByTestId("signin-password-input"), {
      target: { value: "hunter22hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(signInMutate).not.toHaveBeenCalled();
  });

  it("clears the error and submits once the email is valid", () => {
    render(<SignInPage />);
    fireEvent.change(emailInput(), { target: { value: "bad" } });
    fireEvent.change(emailInput(), { target: { value: "user@example.com" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByTestId("signin-password-input"), {
      target: { value: "hunter22hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(signInMutate).toHaveBeenCalledOnce();
  });
});

describe("ForgotPasswordPage — inline email validation", () => {
  it("flags a malformed email and blocks the submit", () => {
    render(<ForgotPasswordPage />);
    const input = emailInput();
    fireEvent.change(input, { target: { value: "nope" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent ?? "").toMatch(
      /valid email address/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /send reset link/i }));
    expect(forgotMutate).not.toHaveBeenCalled();
  });
});

describe("SignUpPage — inline email validation", () => {
  it("flags a malformed email and blocks the submit", () => {
    render(<SignUpPage />);
    const input = emailInput();
    fireEvent.change(input, { target: { value: "bad@" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("signup-email-error");
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(signUpMutate).not.toHaveBeenCalled();
  });
});
