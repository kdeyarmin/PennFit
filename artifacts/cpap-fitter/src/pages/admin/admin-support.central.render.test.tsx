// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminSupportPage } from "./admin-support";

vi.mock("@/lib/admin/support-api", () => ({
  addSupportMessage: vi.fn(),
  createSupportTicket: vi.fn(),
  getSupportTicket: vi.fn(),
  listSupportTickets: vi.fn(async () => ({ tickets: [] })),
  resolveSupportTicket: vi.fn(),
  statusLabel: vi.fn((status: string) => status),
  statusVariant: vi.fn(() => "neutral"),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("AdminSupportPage central Support Hub handoff", () => {
  it("shows the centralized admin software-support surface when enabled", () => {
    vi.stubEnv("VITE_CENTRAL_SUPPORT_HUB_ENABLED", "true");

    render(<AdminSupportPage />);

    const hubLink = screen.getByTestId("central-support-hub-link");
    const url = new URL(hubLink.getAttribute("href") ?? "");
    expect(url.origin).toBe(
      "https://support-hub-web-production.up.railway.app",
    );
    expect(url.pathname).toBe("/help");
    expect(url.searchParams.get("product")).toBe("breathe");
    expect(url.searchParams.get("route")).toBe("/admin/support");
    expect(hubLink.getAttribute("target")).toBe("_blank");
    expect(hubLink.getAttribute("rel")).toBe("noopener noreferrer");

    expect(screen.getByRole("link", { name: "(877) 521-2890" })).toHaveProperty(
      "href",
      "tel:+18775212890",
    );
    expect(
      screen.getByRole("link", { name: "support@caremetric.ai" }),
    ).toHaveProperty("href", "mailto:support@caremetric.ai");
  });

  it("retains the existing local ticket surface when the flag is off", () => {
    vi.stubEnv("VITE_CENTRAL_SUPPORT_HUB_ENABLED", "false");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AdminSupportPage />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("central-support-hub-link")).toBeNull();
    expect(screen.getByText("Ask for help")).not.toBeNull();
    expect(screen.getByText("Your tickets")).not.toBeNull();
  });
});
