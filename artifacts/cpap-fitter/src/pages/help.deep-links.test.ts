// Tests for the Help Center — hub (pages/help.tsx), the step-by-step
// article pages (pages/help-*.tsx), the shared shell + screenshot
// components, and the App.tsx route registrations.
//
// Static source analysis (same pattern as App.routes.test.ts and
// learn.deep-links.test.ts) because the node vitest environment has no DOM.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const HUB_SRC = readFileSync(path.join(__dirname, "help.tsx"), "utf8");
const LAYOUT_SRC = readFileSync(
  path.join(__dirname, "..", "components", "layout.tsx"),
  "utf8",
);

// Every help guide: route path, page module, exported component.
const GUIDES = [
  {
    href: "/help/find-your-mask",
    module: "help-find-your-mask",
    export: "HelpFindYourMask",
  },
  {
    href: "/help/place-an-order",
    module: "help-place-an-order",
    export: "HelpPlaceAnOrder",
  },
  {
    href: "/help/shop-and-checkout",
    module: "help-shop-and-checkout",
    export: "HelpShopAndCheckout",
  },
  {
    href: "/help/track-your-order",
    module: "help-track-your-order",
    export: "HelpTrackYourOrder",
  },
  {
    href: "/help/create-an-account",
    module: "help-create-an-account",
    export: "HelpCreateAnAccount",
  },
  {
    href: "/help/resupply-reminders",
    module: "help-resupply-reminders",
    export: "HelpResupplyReminders",
  },
  {
    href: "/help/insurance-estimate",
    module: "help-insurance-estimate",
    export: "HelpInsuranceEstimate",
  },
  {
    href: "/help/returns-and-refunds",
    module: "help-returns-and-refunds",
    export: "HelpReturnsAndRefunds",
  },
  {
    href: "/help/reset-password",
    module: "help-reset-password",
    export: "HelpResetPassword",
  },
  {
    href: "/help/save-to-wishlist",
    module: "help-save-to-wishlist",
    export: "HelpSaveToWishlist",
  },
] as const;

function escapeRegExp(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function hasRoute(src: string, routePath: string, component: string): boolean {
  const re = new RegExp(
    `path="${escapeRegExp(routePath)}"[\\s\\S]{0,120}component=\\{${escapeRegExp(component)}\\}`,
  );
  return re.test(src);
}

// ---------------------------------------------------------------------------
// App.tsx — routes + lazy imports
// ---------------------------------------------------------------------------

describe("App.tsx — Help Center hub route", () => {
  it("registers <Route path='/help' component={Help} />", () => {
    expect(hasRoute(APP_SRC, "/help", "Help")).toBe(true);
  });

  it("lazy-imports Help from @/pages/help", () => {
    expect(APP_SRC).toContain('import("@/pages/help")');
    expect(APP_SRC).toContain("m.Help");
  });

  it("registers the /help hub AFTER the specific /help/* guides (Switch order)", () => {
    const hubIdx = APP_SRC.indexOf('path="/help"');
    const firstGuideIdx = APP_SRC.indexOf('path="/help/find-your-mask"');
    expect(hubIdx).toBeGreaterThan(-1);
    expect(firstGuideIdx).toBeGreaterThan(-1);
    expect(firstGuideIdx).toBeLessThan(hubIdx);
  });
});

describe("App.tsx — Help Center guide routes", () => {
  for (const g of GUIDES) {
    it(`registers <Route path='${g.href}' component={${g.export}} />`, () => {
      expect(hasRoute(APP_SRC, g.href, g.export)).toBe(true);
    });

    it(`lazy-imports ${g.export} from @/pages/${g.module}`, () => {
      expect(APP_SRC).toContain(`import("@/pages/${g.module}")`);
      expect(APP_SRC).toContain(`m.${g.export}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Navigation wiring
// ---------------------------------------------------------------------------

describe("layout.tsx — Help is wired into navigation", () => {
  it("adds a /help entry to the header navLinks", () => {
    expect(LAYOUT_SRC).toContain('{ href: "/help", label: "Help" }');
  });

  it("links to the Help Center from the footer", () => {
    expect(LAYOUT_SRC).toContain('href="/help"');
    expect(LAYOUT_SRC).toContain("Help Center");
  });
});

// ---------------------------------------------------------------------------
// Hub page
// ---------------------------------------------------------------------------

describe("help.tsx — hub structure", () => {
  it("exports the Help function", () => {
    expect(HUB_SRC).toContain("export function Help");
  });

  it("sets a 'Help Center' document title", () => {
    expect(HUB_SRC).toContain("useDocumentTitle");
    expect(HUB_SRC).toContain("Help Center");
  });

  it("links to every guide from the hub", () => {
    for (const g of GUIDES) {
      expect(HUB_SRC).toContain(g.href);
    }
  });

  it("groups topics into categories", () => {
    expect(HUB_SRC).toContain("HelpCategory");
    expect(HUB_SRC).toContain("getting-started");
    expect(HUB_SRC).toContain("shopping");
    expect(HUB_SRC).toContain("account");
    expect(HUB_SRC).toContain("insurance");
  });

  it("provides a search box", () => {
    expect(HUB_SRC).toContain("help-search-input");
  });
});

// ---------------------------------------------------------------------------
// Each guide page — exports, shell usage, screenshots, breadcrumb
// ---------------------------------------------------------------------------

for (const g of GUIDES) {
  describe(`${g.module}.tsx — structural checks`, () => {
    const src = readFileSync(path.join(__dirname, `${g.module}.tsx`), "utf8");

    it(`exports function ${g.export}`, () => {
      expect(src).toContain(`export function ${g.export}`);
    });

    it("renders through the shared HelpArticleShell", () => {
      expect(src).toContain("HelpArticleShell");
    });

    it("includes at least one Screenshot mock-up", () => {
      expect(src).toContain("Screenshot");
      expect(src).toContain("@/components/help/help-screens");
    });

    it("provides a metaDescription for SEO", () => {
      expect(src).toContain("metaDescription");
    });

    it("provides a quick-answer summary", () => {
      expect(src).toContain("summary={");
    });

    it("lists prerequisites (what you'll need)", () => {
      expect(src).toContain("prerequisites={");
    });

    it("chains to a next guide/step", () => {
      expect(src).toContain("next={");
    });
  });
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

describe("help shared components exist and are exported", () => {
  const shell = readFileSync(
    path.join(__dirname, "..", "components", "help", "help-article-shell.tsx"),
    "utf8",
  );
  const screens = readFileSync(
    path.join(__dirname, "..", "components", "help", "help-screens.tsx"),
    "utf8",
  );

  it("HelpArticleShell renders a Help Center breadcrumb back to /help", () => {
    expect(shell).toContain("export function HelpArticleShell");
    expect(shell).toContain('href="/help"');
  });

  it("HelpArticleShell renders numbered steps", () => {
    expect(shell).toContain("help-step-");
    expect(shell).toContain("step-");
  });

  it("help-screens exports the Screenshot frame", () => {
    expect(screens).toContain("export function Screenshot");
  });

  it("every guide's screenshots carry an accessible <title>", () => {
    // role="img" SVGs must have a <title> for screen-reader users.
    const titleCount = (screens.match(/<title>/g) ?? []).length;
    const roleImgCount = (screens.match(/role="img"/g) ?? []).length;
    expect(roleImgCount).toBeGreaterThan(0);
    expect(titleCount).toBeGreaterThanOrEqual(roleImgCount);
  });

  it("HelpArticleShell supports the enhanced helpers", () => {
    // Quick answer, prerequisites, granular substeps, tip/note/warning
    // callouts, next-step chaining, print, and the helpful widget.
    for (const token of [
      "summary",
      "prerequisites",
      "substeps",
      "warning",
      "Callout",
      "next",
      "window.print()",
      "HelpfulWidget",
      "Was this helpful?",
      "What you",
    ]) {
      expect(shell).toContain(token);
    }
  });
});
