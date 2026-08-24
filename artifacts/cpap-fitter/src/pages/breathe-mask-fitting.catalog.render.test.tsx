// @vitest-environment jsdom
//
// Render coverage for the catalog-coverage section of
// /breathe/mask-fitting — the manufacturer roster a prospective DME reads
// to answer "does it already know the masks I dispense?".
//
// These are the invariants that would embarrass us in front of a prospect,
// asserted against the real DOM rather than the source text:
//   * the roster is never empty, a spinner, or a row of zeros — the
//     verified snapshot backs both first paint and every failure mode;
//   * the "Live count" badge appears only when live numbers actually
//     landed (the section's whole argument is that they are counted);
//   * a child count the API could not compute is hidden, not shown as 0;
//   * no row carries `.bx-reveal` — useRevealOnScroll observes once on
//     mount, so a row that first appears with the live data would never
//     receive `.in` and would stay permanently invisible.

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// The page module imports the Breathe shell for its OTHER sections; the
// coverage section needs none of it. Stub it so this stays a focused
// render rather than mounting the whole 6k-line marketing chrome.
vi.mock("./breathe", () => ({
  BreatheShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  PageHead: () => null,
  ClosingCta: () => null,
}));

import { CatalogCoverageSection } from "./breathe-mask-fitting";
import { FALLBACK_COVERAGE } from "@/lib/mask-catalog-coverage";

const LIVE = {
  manufacturers: [
    { name: "ResMed", models: 40, currentModels: 33 },
    { name: "Sleepnet", models: 1, currentModels: 1 },
  ],
  interfaceTypes: [{ type: "nasal_pillow", models: 41 }],
  totals: {
    manufacturers: 2,
    models: 41,
    currentModels: 34,
    discontinuedModels: 7,
    sizeVariants: 512,
    components: 400,
  },
  lastUpdatedAt: "2026-08-22T06:36:41.066Z",
};

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = await impl();
      return { ok: true, json: async () => body } as unknown as Response;
    }),
  );
}

beforeEach(() => cleanup());
afterEach(() => vi.unstubAllGlobals());

/** Every manufacturer row currently in the DOM, as [name, count] pairs. */
function rosterRows(): [string, string][] {
  return Array.from(document.querySelectorAll(".bx-mfg-row")).map((li) => [
    li.querySelector(".bx-mfg-name")!.textContent!,
    li.querySelector(".bx-mfg-count b")!.textContent!,
  ]);
}

/** The headline tiles across the panel, as [value, label] pairs. */
function totalTiles(): [string, string][] {
  return Array.from(document.querySelectorAll(".bx-mfg-total")).map((el) => [
    el.querySelector("b")!.textContent!,
    el.querySelector("span")!.textContent!,
  ]);
}

describe("catalog coverage — the live path", () => {
  it("renders the roster the endpoint returned", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    expect(rosterRows()).toEqual([
      ["ResMed", "40"],
      ["Sleepnet", "1"],
    ]);
    expect(totalTiles()).toEqual([
      ["41", "mask models"],
      ["2", "manufacturers"],
      ["512", "sized variants with millimetre bands"],
      ["400", "replacement parts, HCPCS-coded"],
    ]);
  });

  it("shows the current / discontinued split behind the headline total", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    const caption = document.querySelector(".bx-mfg-caption")!.textContent!;
    expect(caption).toContain("34");
    expect(caption).toContain("currently marketed");
    expect(caption).toContain("7");
    expect(caption).toContain("discontinued");
  });

  it("labels an interface type the label map does not know", async () => {
    stubFetch(async () => ({
      ...LIVE,
      interfaceTypes: [{ type: "oro_nasal", models: 3 }],
    }));
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    expect(document.querySelector(".bx-mfg-type")!.textContent).toContain(
      "Oro nasal",
    );
  });

  it("calls the public platform endpoint exactly once", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/api/platform/mask-catalog",
    );
  });

  it("shows the Live count badge and the freshness date", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(screen.getByText(/Live count/)).toBeTruthy());
    expect(document.body.textContent).toContain("last updated August 22, 2026");
  });

  it("singularises a one-model manufacturer", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    const units = Array.from(document.querySelectorAll(".bx-mfg-count i")).map(
      (n) => n.textContent,
    );
    expect(units).toEqual(["models", "model"]);
  });

  it("scales each share bar to the widest roster", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    const widths = Array.from(
      document.querySelectorAll<HTMLElement>(".bx-mfg-bar"),
    ).map((n) => n.style.width);
    // 40/40 and 1/40.
    expect(widths[0]).toBe("100%");
    expect(widths[1]).toBe("2.5%");
  });

  it("hides a child-count tile the API could not compute", async () => {
    stubFetch(async () => ({
      ...LIVE,
      totals: { ...LIVE.totals, sizeVariants: null },
    }));
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    expect(document.body.textContent).not.toContain(
      "sized variants with millimetre bands",
    );
    // The tile that IS computable still renders.
    expect(document.body.textContent).toContain("replacement parts");
  });
});

describe("catalog coverage — never empty in front of a prospect", () => {
  it("paints the verified snapshot before the fetch resolves", () => {
    stubFetch(() => new Promise(() => {})); // never settles
    render(<CatalogCoverageSection />);

    expect(rosterRows()).toHaveLength(FALLBACK_COVERAGE.manufacturers.length);
    expect(rosterRows()[0]).toEqual(["ResMed", "25"]);
    expect(totalTiles()[0]).toEqual(["83", "mask models"]);
  });

  it.each([
    [
      "the endpoint's empty fail-soft body",
      async () => ({ manufacturers: [] }),
    ],
    ["a garbage body", async () => "nope"],
    ["a rejected fetch (offline)", () => Promise.reject(new Error("offline"))],
  ])("keeps the snapshot on %s", async (_label, impl) => {
    stubFetch(impl as () => Promise<unknown>);
    render(<CatalogCoverageSection />);

    // Give the effect a turn to settle before asserting nothing changed.
    await new Promise((r) => setTimeout(r, 0));
    expect(rosterRows()).toHaveLength(FALLBACK_COVERAGE.manufacturers.length);
    expect(totalTiles()[0]).toEqual(["83", "mask models"]);
  });

  it("does not claim a live count while showing the snapshot", async () => {
    stubFetch(async () => ({ manufacturers: [] }));
    render(<CatalogCoverageSection />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Live count/)).toBeNull();
    expect(document.body.textContent).toContain(
      "Counted from the platform catalog",
    );
    // With no live payload there is no date to stand behind.
    expect(document.body.textContent).not.toContain("last updated");
  });
});

describe("catalog coverage — reveal animation invariant", () => {
  it("keeps .bx-reveal off every element that re-renders with live data", async () => {
    stubFetch(async () => LIVE);
    render(<CatalogCoverageSection />);

    await waitFor(() => expect(rosterRows()).toHaveLength(2));
    // useRevealOnScroll (breathe.tsx) observes `.bx-reveal` ONCE on mount.
    // Anything keyed off the live payload is re-created after that pass, so
    // carrying the class would leave it stuck at opacity: 0 forever.
    for (const cls of [".bx-mfg-row", ".bx-mfg-type", ".bx-mfg-total"]) {
      expect(document.querySelectorAll(`${cls}.bx-reveal`)).toHaveLength(0);
    }
    // The stable wrapper, which exists from first paint, does carry it.
    expect(document.querySelectorAll(".bx-mfg-panel.bx-reveal")).toHaveLength(
      1,
    );
  });
});
