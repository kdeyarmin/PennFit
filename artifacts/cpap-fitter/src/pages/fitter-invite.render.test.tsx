// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const { resolveFitterInvite, track } = vi.hoisted(() => ({
  resolveFitterInvite: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/shop-api", () => ({ resolveFitterInvite }));
vi.mock("@/lib/track", () => ({ track }));
vi.mock("@/hooks/use-document-title", () => ({ useDocumentTitle: vi.fn() }));
vi.mock("@/components/company-contact", () => ({
  BrandName: () => "Care team",
}));
vi.mock("wouter", () => ({ useLocation: () => ["/fitter-invite", vi.fn()] }));

import { FitterProvider } from "@/hooks/use-fitter-store";
import { FitterInvite } from "./fitter-invite";

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/fitter-invite?t=invite-one");
});
afterEach(cleanup);

describe("fitter invite resolution", () => {
  it("finishes loading after the store provider rerenders during the request", async () => {
    let resolve!: (value: unknown) => void;
    resolveFitterInvite.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(
      <FitterProvider>
        <FitterInvite />
      </FitterProvider>,
    );
    view.rerender(
      <FitterProvider>
        <FitterInvite />
      </FitterProvider>,
    );

    await act(async () => {
      resolve({ valid: true, name: "Alex Demo", email: "alex@example.com" });
    });

    expect(screen.getByTestId("button-start-invited-fitting")).toBeTruthy();
    expect(resolveFitterInvite).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("resolves once when React replays mount effects", async () => {
    resolveFitterInvite.mockResolvedValue({ valid: true, name: "Alex Demo" });
    render(
      <StrictMode>
        <FitterProvider>
          <FitterInvite />
        </FitterProvider>
      </StrictMode>,
    );

    expect(
      await screen.findByTestId("button-start-invited-fitting"),
    ).toBeTruthy();
    expect(resolveFitterInvite).toHaveBeenCalledTimes(1);
  });
});
