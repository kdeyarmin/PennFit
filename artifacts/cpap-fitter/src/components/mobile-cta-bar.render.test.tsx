// @vitest-environment jsdom
//
// Behavioral coverage for MobileCtaBar — the sticky mobile quick-action
// bar that must point at insurance ordering (not the retired /shop route).

import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";

import { MobileCtaBar } from "./mobile-cta-bar";

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  return render(
    <Router base="">
      <MobileCtaBar />
    </Router>,
  );
}

afterEach(() => cleanup());

describe("MobileCtaBar", () => {
  it("renders Get fitted → /consent, Order → /insurance, Talk to us → /help", () => {
    renderAt("/");
    const fit = screen.getByTestId("mobile-cta-fit");
    const order = screen.getByTestId("mobile-cta-order");
    const talk = screen.getByTestId("mobile-cta-talk");

    expect(fit.getAttribute("href")).toBe("/consent");
    expect(fit.textContent).toContain("Get fitted");
    expect(order.getAttribute("href")).toBe("/insurance");
    expect(order.textContent).toContain("Order");
    expect(talk.getAttribute("href")).toBe("/help");
    expect(talk.textContent).toContain("Talk to us");
  });

  it("does not link to the retired /shop route", () => {
    renderAt("/");
    expect(screen.queryByTestId("mobile-cta-shop")).toBeNull();
    const links = screen.getAllByRole("link");
    for (const link of links) {
      expect(link.getAttribute("href")).not.toMatch(/^\/shop/);
    }
  });

  it("hides on fit-flow and auth routes", () => {
    renderAt("/capture");
    expect(screen.queryByTestId("mobile-cta-bar")).toBeNull();
    cleanup();
    renderAt("/sign-in");
    expect(screen.queryByTestId("mobile-cta-bar")).toBeNull();
  });
});
