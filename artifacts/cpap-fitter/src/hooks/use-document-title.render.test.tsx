// @vitest-environment jsdom
//
// Behavioral coverage for useDocumentTitle's brand resolution — the part
// the source-guard tests in use-document-title.test.ts cannot prove.
// Renders a component that calls the hook and asserts what actually
// lands in the document after effects run:
//
//   * the landing page (empty pageTitle) gets the RESOLVED tenant brand
//     in the tab title, meta description, og:title, and og:site_name —
//     never the static shell's platform placeholders;
//   * the /breathe/* platform marketing routes pin the PLATFORM identity
//     even though the same host resolves a tenant;
//   * unmount restores the shell's previous values.
//
// The contact module is mocked to a fictional DME so the assertions
// prove the values flow from the resolver — a hardcoded brand could not
// produce them.

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { DEFAULT_COMPANY_CONTACT } from "@/lib/contact";

const contact = {
  ...DEFAULT_COMPANY_CONTACT,
  name: "Acme Home Medical",
  legalName: "Acme Home Medical LLC",
};

vi.mock("@/lib/contact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/contact")>();
  return { ...actual, useCompanyContact: () => contact };
});

import { useDocumentTitle } from "./use-document-title";
import { PLATFORM_NAME } from "@/lib/branding";

function Page({ title, desc }: { title: string; desc?: string }) {
  useDocumentTitle(title, desc);
  return null;
}

const SHELL_TITLE = "CareMetric Breathe — CPAP Fitter & Resupply";
const SHELL_DESCRIPTION = "CareMetric Breathe is the online platform.";

function metaContent(selector: string): string | null {
  return (
    document.head
      .querySelector<HTMLMetaElement>(selector)
      ?.getAttribute("content") ?? null
  );
}

beforeEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
  // Mirror the static shell: platform-placeholder title + description.
  document.title = SHELL_TITLE;
  document.head
    .querySelectorAll("meta, link[rel='canonical']")
    .forEach((el) => el.remove());
  const desc = document.createElement("meta");
  desc.setAttribute("name", "description");
  desc.setAttribute("content", SHELL_DESCRIPTION);
  document.head.appendChild(desc);
});

describe("useDocumentTitle — tenant-branded landing metadata", () => {
  it("replaces the shell's platform title/description with the resolved tenant", () => {
    render(<Page title="" />);
    expect(document.title).toBe("Acme Home Medical — CPAP Fitter & Resupply");
    expect(metaContent('meta[name="description"]')).toContain(
      "Acme Home Medical",
    );
    expect(metaContent('meta[property="og:title"]')).toContain(
      "Acme Home Medical",
    );
    expect(metaContent('meta[property="og:site_name"]')).toBe(
      "Acme Home Medical",
    );
    expect(document.title).not.toContain("CareMetric");
  });

  it("suffixes per-page titles with the resolved tenant brand", () => {
    render(<Page title="Your mask matches" desc="Ranked matches." />);
    expect(document.title).toBe("Your mask matches — Acme Home Medical");
    expect(metaContent('meta[name="description"]')).toBe("Ranked matches.");
    expect(metaContent('meta[property="og:description"]')).toBe(
      "Ranked matches.",
    );
  });

  it("restores the shell's values on unmount", () => {
    const { unmount } = render(<Page title="" />);
    unmount();
    expect(document.title).toBe(SHELL_TITLE);
    expect(metaContent('meta[name="description"]')).toBe(SHELL_DESCRIPTION);
  });
});

describe("useDocumentTitle — /breathe/* pins the platform identity", () => {
  it("brands the platform marketing surface as the platform, not the tenant", () => {
    // The same (mocked-tenant) host: only the route differs.
    window.history.pushState({}, "", "/breathe/features");
    render(<Page title="Features" />);
    expect(document.title).toBe(`Features — ${PLATFORM_NAME}`);
    expect(metaContent('meta[property="og:site_name"]')).toBe(PLATFORM_NAME);
    expect(document.title).not.toContain("Acme");
  });

  it("treats the /breathe root itself as platform surface", () => {
    window.history.pushState({}, "", "/breathe");
    render(<Page title="" />);
    expect(document.title).toBe(`${PLATFORM_NAME} — CPAP Fitter & Resupply`);
  });
});
