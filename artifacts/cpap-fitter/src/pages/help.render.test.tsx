// @vitest-environment jsdom
//
// Render smoke coverage for the Help Center. The rest of the Help
// Center suite (help.deep-links.test.ts) is static source analysis;
// this file proves the hub and every step-by-step guide actually
// mount into the DOM — catching runtime regressions (a bad import, a
// malformed SVG mock-up, a missing required shell prop) that source
// scanning can't see.

import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "wouter";

import { Help } from "./help";
import { HelpFindYourMask } from "./help-find-your-mask";
import { HelpPlaceAnOrder } from "./help-place-an-order";
import { HelpShopAndCheckout } from "./help-shop-and-checkout";
import { HelpTrackYourOrder } from "./help-track-your-order";
import { HelpCreateAnAccount } from "./help-create-an-account";
import { HelpResupplyReminders } from "./help-resupply-reminders";
import { HelpInsuranceEstimate } from "./help-insurance-estimate";
import { HelpReturnsAndRefunds } from "./help-returns-and-refunds";

afterEach(() => cleanup());

function renderAt(node: React.ReactNode) {
  return render(<Router base="">{node}</Router>);
}

describe("Help Center hub renders", () => {
  it("mounts the hub with its heading and search box", () => {
    renderAt(<Help />);
    expect(screen.getByText("How can we help?")).toBeTruthy();
    expect(screen.getByTestId("help-search-input")).toBeTruthy();
  });

  it("links to every guide and shows the category sections", () => {
    renderAt(<Help />);
    expect(screen.getByTestId("help-category-getting-started")).toBeTruthy();
    expect(screen.getByTestId("help-topic-find-your-mask")).toBeTruthy();
    expect(screen.getByTestId("help-topic-returns-and-refunds")).toBeTruthy();
  });
});

const GUIDES: Array<[string, React.ReactNode, string]> = [
  [
    "find your mask",
    <HelpFindYourMask />,
    "Find your mask with the Virtual Fitter",
  ],
  ["place an order", <HelpPlaceAnOrder />, "Order your recommended mask"],
  ["shop and checkout", <HelpShopAndCheckout />, "Shop supplies & check out"],
  ["track your order", <HelpTrackYourOrder />, "Track your order"],
  ["create an account", <HelpCreateAnAccount />, "Create an account & sign in"],
  [
    "resupply reminders",
    <HelpResupplyReminders />,
    "Set up resupply reminders",
  ],
  [
    "insurance estimate",
    <HelpInsuranceEstimate />,
    "Get an insurance estimate",
  ],
  [
    "returns and refunds",
    <HelpReturnsAndRefunds />,
    "Returns, exchanges & refunds",
  ],
];

describe("Help Center guides render", () => {
  for (const [name, node, heading] of GUIDES) {
    it(`mounts the "${name}" guide with its heading, numbered steps, and a screenshot`, () => {
      renderAt(node);
      // Page heading (h1) is present.
      expect(
        screen.getByRole("heading", { level: 1, name: heading }),
      ).toBeTruthy();
      // The breadcrumb back to the hub is present.
      expect(screen.getByTestId("help-breadcrumb-home")).toBeTruthy();
      // At least step 1 rendered.
      const stepOne = document.querySelector('[data-testid^="help-step-"]');
      expect(stepOne).toBeTruthy();
      // At least one screenshot SVG (role="img") rendered.
      expect(document.querySelector('svg[role="img"]')).toBeTruthy();
    });
  }
});
