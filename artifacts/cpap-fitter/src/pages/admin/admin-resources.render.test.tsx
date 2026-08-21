// @vitest-environment jsdom
//
// Render tests for the staff Help Center (/admin/resources and its
// sub-pages). The content itself is guarded structurally by
// src/content/admin-help/admin-help.coverage.test.ts; these cover the
// behavior that only shows up once it is rendered:
//
//   * the hub's search actually narrows to matching articles,
//   * a how-to's `/admin/...` path references become real links,
//   * a bad slug degrades to a "not found" card instead of throwing,
//   * the FAQ's deep-link opens the targeted question expanded.

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import { AdminResourcesPage } from "./admin-resources";
import { AdminResourceHowToPage } from "./admin-resources-how-to";
import { AdminResourceFaqPage } from "./admin-resources-faq";
import { AdminResourceUserGuidePage } from "./admin-resources-user-guide";
import { GUIDE_SECTIONS, HOW_TO_GUIDES } from "@/content/admin-help";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function renderAt(path: string, ui: React.JSX.Element) {
  const { hook } = memoryLocation({ path, static: false });
  return render(<Router hook={hook}>{ui}</Router>);
}

describe("Help Center hub", () => {
  it("lists every how-to guide", () => {
    renderAt("/admin/resources", <AdminResourcesPage />);
    for (const g of HOW_TO_GUIDES) {
      expect(
        screen.getAllByText(g.title).length,
        `${g.slug} is not linked from the hub`,
      ).toBeGreaterThan(0);
    }
  });

  it("links to the user guide, the FAQ, and Support", () => {
    const { container } = renderAt("/admin/resources", <AdminResourcesPage />);
    const hrefs = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/admin/resources/user-guide");
    expect(hrefs).toContain("/admin/resources/faq");
    expect(hrefs).toContain("/admin/support");
  });

  it("search narrows the page to matching results", () => {
    renderAt("/admin/resources", <AdminResourcesPage />);
    // Before searching, the browse view shows the category headings.
    expect(screen.getByTestId("help-category-billing")).toBeTruthy();

    fireEvent.change(screen.getByTestId("admin-help-search"), {
      target: { value: "denials" },
    });

    expect(screen.queryByTestId("help-category-billing")).toBeNull();
    expect(
      screen.getByText("Work denials so the winnable ones get won"),
    ).toBeTruthy();
  });

  it("tells the reader when nothing matched", () => {
    renderAt("/admin/resources", <AdminResourcesPage />);
    fireEvent.change(screen.getByTestId("admin-help-search"), {
      target: { value: "zzzzznotathing" },
    });
    expect(screen.getByText("Nothing matched that search.")).toBeTruthy();
  });
});

describe("how-to article", () => {
  it("renders the steps of the requested guide", () => {
    renderAt(
      "/admin/resources/how-to/verify-a-patients-insurance",
      <AdminResourceHowToPage />,
    );
    expect(
      screen.getByTestId("admin-help-article-verify-a-patients-insurance"),
    ).toBeTruthy();
    expect(screen.getByTestId("help-step-1")).toBeTruthy();
    expect(screen.getByText("Open Verify insurance")).toBeTruthy();
  });

  it("turns /admin/... path references into working links", () => {
    const { container } = renderAt(
      "/admin/resources/how-to/verify-a-patients-insurance",
      <AdminResourceHowToPage />,
    );
    const consoleLinks = [
      ...container.querySelectorAll('[data-testid="help-console-link"]'),
    ].map((el) => el.getAttribute("href"));
    expect(consoleLinks).toContain("/admin/billing/verify");
  });

  it("shows prerequisites and troubleshooting when the guide has them", () => {
    renderAt(
      "/admin/resources/how-to/verify-a-patients-insurance",
      <AdminResourceHowToPage />,
    );
    expect(screen.getByTestId("help-prerequisites")).toBeTruthy();
    expect(screen.getByText("If something goes wrong")).toBeTruthy();
  });

  it("degrades to a not-found card for an unknown slug", () => {
    renderAt(
      "/admin/resources/how-to/no-such-guide",
      <AdminResourceHowToPage />,
    );
    expect(screen.getByText("That guide doesn't exist")).toBeTruthy();
  });
});

describe("user guide", () => {
  it("renders every chapter with an anchor id", () => {
    const { container } = renderAt(
      "/admin/resources/user-guide",
      <AdminResourceUserGuidePage />,
    );
    for (const s of GUIDE_SECTIONS) {
      expect(
        container.querySelector(`#${s.id}`),
        `missing anchor for ${s.id}`,
      ).toBeTruthy();
    }
  });

  it("renders a contents list linking to each chapter", () => {
    renderAt("/admin/resources/user-guide", <AdminResourceUserGuidePage />);
    const contents = screen.getByRole("navigation", { name: "Guide contents" });
    for (const s of GUIDE_SECTIONS) {
      expect(within(contents).getByText(s.title).getAttribute("href")).toBe(
        `#${s.id}`,
      );
    }
  });
});

describe("FAQ", () => {
  it("collapses answers until a question is opened", () => {
    renderAt("/admin/resources/faq", <AdminResourceFaqPage />);
    const question = screen.getByText(
      "A patient texted STOP. Can I turn their texts back on?",
    );
    const button = question.closest("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button!);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the targeted question when arrived at by deep link", () => {
    window.location.hash = "#patient-said-stop";
    renderAt("/admin/resources/faq", <AdminResourceFaqPage />);
    const button = screen
      .getByText("A patient texted STOP. Can I turn their texts back on?")
      .closest("button");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  it("filters the list", () => {
    renderAt("/admin/resources/faq", <AdminResourceFaqPage />);
    fireEvent.change(screen.getByTestId("admin-faq-filter"), {
      target: { value: "pacware" },
    });
    expect(screen.getByText("Does PacWare sync automatically?")).toBeTruthy();
    expect(
      screen.queryByText(
        "A patient texted STOP. Can I turn their texts back on?",
      ),
    ).toBeNull();
  });
});
