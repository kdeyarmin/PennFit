// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { view, refetch, query, TestApiError } = vi.hoisted(() => {
  const refetch = vi.fn();
  const query = {
    data: undefined as Record<string, unknown> | undefined,
    error: null as Error | null,
    isLoading: false,
    isFetching: false,
    refetch,
  };
  return {
    refetch,
    query,
    view: vi.fn(() => query),
    TestApiError: class extends Error {
      constructor(public data: { error: string }) {
        super(data.error);
      }
    },
  };
});
vi.mock("@workspace/api-client-react/storefront", () => ({
  useViewCsrOrder: view,
  useViewPatientPacket: view,
  useSignCsrOrder: () => ({ isPending: false }),
  useSignPatientPacket: () => ({ isPending: false }),
  ApiError: TestApiError,
}));
vi.mock("@/hooks/use-document-title", () => ({ useDocumentTitle: vi.fn() }));
import { OrderSign } from "./order-sign";
import { PatientPacketSign } from "./patient-packet-sign";

beforeEach(() => {
  vi.clearAllMocks();
  query.data = undefined;
  query.error = new Error("Network unavailable");
  query.isFetching = false;
});
afterEach(cleanup);

describe.each([
  {
    path: "/order-sign",
    Page: OrderSign,
    completed: { signed: true },
    success: "Order confirmed",
  },
  {
    path: "/patient-packet-sign",
    Page: PatientPacketSign,
    completed: { status: "completed" },
    success: "You're all set",
  },
])("$path recovery", ({ path, Page, completed, success }) => {
  beforeEach(() => {
    window.history.replaceState({}, "", `${path}?token=private-token`);
  });

  it("retries without reloading or losing the private token", () => {
    const rendered = render(<Page />);
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);

    query.isFetching = true;
    rendered.rerender(<Page />);
    expect(
      (
        screen.getByRole("button", {
          name: "Trying again…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(view).toHaveBeenLastCalledWith("private-token");
  });

  it("does not offer retry for an expired signing link", () => {
    query.error = new TestApiError({ error: "expired" });
    render(<Page />);
    expect(screen.getByText("This link has expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("respects an expired link response even with cached completed data", () => {
    query.data = completed;
    query.error = new TestApiError({ error: "expired" });
    render(<Page />);
    expect(screen.getByText("This link has expired")).toBeTruthy();
    expect(screen.queryByText(success)).toBeNull();
  });

  it("keeps a confirmed signature visible when a background refresh fails", () => {
    query.data = completed;
    render(<Page />);
    expect(screen.getByText(success)).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
