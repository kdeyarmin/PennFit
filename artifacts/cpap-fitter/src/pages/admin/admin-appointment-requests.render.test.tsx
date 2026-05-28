// @vitest-environment jsdom
//
// Render tests for the `RequestRow` component in admin-appointment-requests.tsx.
//
// PR change: the `useMutation` `onError` handler was added so that
// when `updateAppointmentRequest` fails, a destructive toast is displayed
// to the CSR. Without this, the button would silently return to idle
// and the CSR would assume the status change had taken effect.
//
// Coverage:
//   * When the mutation errors with an Error instance, the toast is called
//     with the error's message and variant: "destructive"
//   * When the mutation errors with a non-Error value, a fallback message
//     is used
//   * The toast title is "Couldn't update appointment request"
//   * When the mutation succeeds, no toast is fired (regression guard)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// ── Hoisted state — accessible inside vi.mock() factories ────────────────────

const {
  toastSpy,
  mutateSpy,
  capturedCallbacks,
} = vi.hoisted(() => {
  const capturedCallbacks: {
    onSuccess?: () => void;
    onError?: (err: unknown) => void;
  } = {};
  return {
    toastSpy: vi.fn(),
    mutateSpy: vi.fn(),
    capturedCallbacks,
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: () => ({
      data: {
        requests: [
          {
            id: "req-1",
            status: "new",
            topic: "Fitting help",
            requesterName: "Jane Doe",
            requesterEmail: "jane@example.com",
            requesterPhone: null,
            notes: null,
            preferredWindow: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useMutation: (opts: {
      mutationFn?: (status: string) => Promise<unknown>;
      onSuccess?: () => void;
      onError?: (err: unknown) => void;
    }) => {
      capturedCallbacks.onSuccess = opts.onSuccess;
      capturedCallbacks.onError = opts.onError;
      return {
        mutate: mutateSpy,
        isPending: false,
      };
    },
    useQueryClient: () => ({
      invalidateQueries: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

vi.mock("@/lib/admin/appointment-requests-api", () => ({
  listAppointmentRequests: vi.fn().mockResolvedValue({ requests: [] }),
  updateAppointmentRequest: vi.fn().mockResolvedValue({}),
}));

// ── Page import (must come after vi.mock declarations) ────────────────────────

import { AdminAppointmentRequestsPage } from "./admin-appointment-requests";

// ── Test lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  toastSpy.mockReset();
  mutateSpy.mockReset();
  capturedCallbacks.onSuccess = undefined;
  capturedCallbacks.onError = undefined;
  cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RequestRow — onError toast (PR change)", () => {
  it("calls toast with variant 'destructive' and the error message when mutation fails", () => {
    render(<AdminAppointmentRequestsPage />);

    // Clicking any action button causes useMutation to register callbacks.
    // We trigger a click so capturedCallbacks is populated, then fire onError.
    const markBtn = screen.getByRole("button", { name: /mark contacted/i });
    fireEvent.click(markBtn);

    // Directly fire the onError callback with a real Error object
    const err = new Error("Network request failed");
    capturedCallbacks.onError?.(err);

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const toastArgs = toastSpy.mock.calls[0][0] as {
      title: string;
      description: string;
      variant: string;
    };
    expect(toastArgs.variant).toBe("destructive");
    expect(toastArgs.title).toBe("Couldn't update appointment request");
    expect(toastArgs.description).toBe("Network request failed");
  });

  it("uses fallback message when error is not an Error instance", () => {
    render(<AdminAppointmentRequestsPage />);

    const markBtn = screen.getByRole("button", { name: /mark contacted/i });
    fireEvent.click(markBtn);

    // A non-Error thrown value (e.g. a plain string)
    capturedCallbacks.onError?.("unexpected string error");

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const toastArgs = toastSpy.mock.calls[0][0] as {
      title: string;
      description: string;
      variant: string;
    };
    expect(toastArgs.variant).toBe("destructive");
    expect(toastArgs.title).toBe("Couldn't update appointment request");
    expect(toastArgs.description).toBe("Please try again in a moment.");
  });

  it("uses fallback message when error value is null", () => {
    render(<AdminAppointmentRequestsPage />);

    const markBtn = screen.getByRole("button", { name: /mark contacted/i });
    fireEvent.click(markBtn);

    capturedCallbacks.onError?.(null);

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const toastArgs = toastSpy.mock.calls[0][0] as {
      variant: string;
      description: string;
    };
    expect(toastArgs.variant).toBe("destructive");
    expect(toastArgs.description).toBe("Please try again in a moment.");
  });

  it("uses fallback message when error is an object that is not an Error", () => {
    render(<AdminAppointmentRequestsPage />);

    fireEvent.click(screen.getByRole("button", { name: /mark contacted/i }));

    capturedCallbacks.onError?.({ code: "ECONNRESET" });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const { description } = toastSpy.mock.calls[0][0] as {
      description: string;
    };
    expect(description).toBe("Please try again in a moment.");
  });

  it("does NOT call toast when the mutation succeeds", () => {
    render(<AdminAppointmentRequestsPage />);

    const markBtn = screen.getByRole("button", { name: /mark contacted/i });
    fireEvent.click(markBtn);

    capturedCallbacks.onSuccess?.();

    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("renders action buttons for a row with status 'new'", () => {
    render(<AdminAppointmentRequestsPage />);

    // The 'new' status row should show three action buttons
    expect(
      screen.getByRole("button", { name: /mark contacted/i }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /scheduled/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /decline/i })).toBeDefined();
  });
});