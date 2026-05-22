// Tests for pages/account.tsx
//
// PR changes in account.tsx:
//   * ProfileSection extracted to its own file
//     (components/account/ProfileSection.tsx) and imported from there.
//   * Several error-display elements had role="alert" removed:
//       - account-doc-upload-error
//       - account-card-error
//       - account-reorder-error
//       - account-subscription-action-error
//       - cadenceLoadError paragraph
//       - ReportLostLink error span
//   * useUnsavedChangesWarning and updateShopMe are no longer imported
//     directly in account.tsx (they moved into ProfileSection.tsx).
//
// The component relies on React hooks and cannot be rendered in the node
// vitest environment without jsdom, so we use static source analysis.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "account.tsx"), "utf8");
const SECTIONS_DIR = path.join(__dirname, "..", "components", "account");
const DOCS_SRC = readFileSync(
  path.join(SECTIONS_DIR, "DocumentsSection.tsx"),
  "utf8",
);
const ORDERS_SRC = readFileSync(
  path.join(SECTIONS_DIR, "OrdersSection.tsx"),
  "utf8",
);
const SUBS_SRC = readFileSync(
  path.join(SECTIONS_DIR, "SubscriptionsSection.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// ProfileSection extraction — import location
// ---------------------------------------------------------------------------

describe("account — ProfileSection imported from its own module", () => {
  it("imports ProfileSection from @/components/account/ProfileSection", () => {
    expect(SRC).toContain(
      'import { ProfileSection } from "@/components/account/ProfileSection"',
    );
  });

  it("does not define ProfileSection as a local function in account.tsx", () => {
    // The local function definition (not an import) must not exist in this file.
    expect(SRC).not.toMatch(/^function ProfileSection\(/m);
  });

  it("still renders ProfileSection in the JSX tree", () => {
    expect(SRC).toContain("<ProfileSection");
  });
});

// ---------------------------------------------------------------------------
// Imports that moved to ProfileSection.tsx
// ---------------------------------------------------------------------------

describe("account — relocated imports no longer present in account.tsx", () => {
  it("does not import useUnsavedChangesWarning in account.tsx", () => {
    expect(SRC).not.toContain("useUnsavedChangesWarning");
  });

  it("does not import updateShopMe in account.tsx", () => {
    // updateShopMe now lives inside ProfileSection.tsx
    expect(SRC).not.toContain("updateShopMe");
  });

  it("does not import SavedShippingAddress in account.tsx", () => {
    expect(SRC).not.toContain("SavedShippingAddress");
  });
});

// ---------------------------------------------------------------------------
// role="alert" removed — account-doc-upload-error
// ---------------------------------------------------------------------------

describe("account — account-doc-upload-error no longer has role=alert", () => {
  it("still renders data-testid account-doc-upload-error", () => {
    expect(DOCS_SRC).toContain('data-testid="account-doc-upload-error"');
  });

  it("account-doc-upload-error element does not carry role=alert", () => {
    const idx = DOCS_SRC.indexOf('data-testid="account-doc-upload-error"');
    expect(idx).toBeGreaterThan(-1);
    const elementContext = DOCS_SRC.slice(
      DOCS_SRC.lastIndexOf("<p", idx),
      idx + 'data-testid="account-doc-upload-error"'.length + 10,
    );
    expect(elementContext).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// role="alert" removed — account-card-error
// ---------------------------------------------------------------------------

describe("account — account-card-error no longer has role=alert", () => {
  it("still renders data-testid account-card-error", () => {
    expect(SRC).toContain('data-testid="account-card-error"');
  });

  it("account-card-error element does not carry role=alert", () => {
    const idx = SRC.indexOf('data-testid="account-card-error"');
    expect(idx).toBeGreaterThan(-1);
    // Look at the 150 characters before the testid attribute to cover the
    // opening <p and any attributes that precede it.
    const elementContext = SRC.slice(idx - 150, idx + 50);
    expect(elementContext).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// role="alert" removed — account-reorder-error
// ---------------------------------------------------------------------------

describe("account — account-reorder-error no longer has role=alert", () => {
  it("still renders data-testid account-reorder-error", () => {
    expect(ORDERS_SRC).toContain('data-testid="account-reorder-error"');
  });

  it("account-reorder-error element does not carry role=alert", () => {
    const idx = ORDERS_SRC.indexOf('data-testid="account-reorder-error"');
    expect(idx).toBeGreaterThan(-1);
    const elementContext = ORDERS_SRC.slice(idx - 150, idx + 50);
    expect(elementContext).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// role="alert" removed — account-subscription-action-error
// ---------------------------------------------------------------------------

describe("account — account-subscription-action-error no longer has role=alert", () => {
  it("still renders data-testid account-subscription-action-error", () => {
    expect(SUBS_SRC).toContain('data-testid="account-subscription-action-error"');
  });

  it("account-subscription-action-error element does not carry role=alert", () => {
    const idx = SUBS_SRC.indexOf('data-testid="account-subscription-action-error"');
    expect(idx).toBeGreaterThan(-1);
    const elementContext = SUBS_SRC.slice(idx - 150, idx + 50);
    expect(elementContext).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// role="alert" removed — cadence-load error paragraph
// ---------------------------------------------------------------------------

describe("account — cadenceLoadError paragraph no longer has role=alert", () => {
  it("still renders the cadence load error text", () => {
    expect(SUBS_SRC).toContain(
      "Couldn't load cadence options. Please try again.",
    );
  });

  it("cadenceLoadError paragraph does not carry role=alert", () => {
    const errorText = "Couldn't load cadence options. Please try again.";
    const idx = SUBS_SRC.indexOf(errorText);
    expect(idx).toBeGreaterThan(-1);
    const elementContext = SUBS_SRC.slice(idx - 80, idx + errorText.length + 20);
    expect(elementContext).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// role="alert" removed — ReportLostLink error span
// ---------------------------------------------------------------------------

describe("account — ReportLostLink error span no longer has role=alert", () => {
  it("ReportLostLink renders the error message in a span", () => {
    expect(ORDERS_SRC).toContain("result.message");
  });

  it("the error span inside ReportLostLink does not carry role=alert", () => {
    const fnStart = ORDERS_SRC.indexOf("function ReportLostLink(");
    expect(fnStart).toBeGreaterThan(-1);
    const msgIdx = ORDERS_SRC.indexOf("result.message", fnStart);
    expect(msgIdx).toBeGreaterThan(-1);
    const spanContext = ORDERS_SRC.slice(msgIdx - 100, msgIdx + 50);
    expect(spanContext).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// Regression: Field helper function not defined in account.tsx
// ---------------------------------------------------------------------------

describe("account — Field helper is not defined in account.tsx (moved to ProfileSection.tsx)", () => {
  it("does not contain a local Field function declaration", () => {
    // The Field label-wrapper component moved to ProfileSection.tsx.
    expect(SRC).not.toMatch(/^function Field\(/m);
  });
});

// ---------------------------------------------------------------------------
// PR change: formatMoneyCents removed from @/lib/shop-api import
// ---------------------------------------------------------------------------

describe("account — formatMoneyCents no longer imported from @/lib/shop-api", () => {
  it("does not import formatMoneyCents from shop-api", () => {
    // formatMoneyCents was removed from the shop-api import in this PR
    // because it is not used anywhere in account.tsx.
    expect(SRC).not.toContain("formatMoneyCents");
  });

  it("still imports fetchShopProducts from @/lib/shop-api", () => {
    // fetchShopProducts remains in use (preview-mode probe).
    expect(SRC).toContain('import { fetchShopProducts } from "@/lib/shop-api"');
  });

  it("shop-api import does not list formatMoneyCents alongside fetchShopProducts", () => {
    // Ensure the import declaration is a clean single-name import.
    const shopApiImport = SRC.match(/import\s*\{[^}]*\}\s*from\s*["']@\/lib\/shop-api["']/);
    expect(shopApiImport).not.toBeNull();
    expect(shopApiImport![0]).not.toContain("formatMoneyCents");
  });

  it("shop-api import contains exactly one exported name (fetchShopProducts only)", () => {
    // After the PR the brace-group must contain only fetchShopProducts —
    // no trailing comma or second identifier.
    const shopApiImport = SRC.match(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/shop-api["']/);
    expect(shopApiImport).not.toBeNull();
    const names = shopApiImport![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("fetchShopProducts");
  });

  it("formatMoneyCents does not appear anywhere in account.tsx (not used, not re-exported)", () => {
    // Belt-and-suspenders: the identifier must be absent from the whole file,
    // not just the import line, to confirm it was completely removed.
    expect(SRC).not.toContain("formatMoneyCents");
  });
});

// ---------------------------------------------------------------------------
// RemindersSection — P5: new tile on /account (process-simplification PR)
// ---------------------------------------------------------------------------
// Signed-in customers previously had to dig through a confirmation email to
// reach /reminders/manage. The backend now resolves manage requests by
// session email (no magic-link token required). This tile gives customers a
// direct /account → /reminders/manage shortcut, and a secondary link to
// /reminders for customers who haven't subscribed yet.

describe("account — RemindersSection added (P5)", () => {
  it("defines a RemindersSection function in account.tsx", () => {
    expect(SRC).toContain("function RemindersSection");
  });

  it("renders RemindersSection inside AccountInner's section list", () => {
    expect(SRC).toContain("<RemindersSection />");
  });

  it("wraps the tile in a section with data-testid='account-reminders-section'", () => {
    expect(SRC).toContain('data-testid="account-reminders-section"');
  });

  it("imports Bell from lucide-react for the section header icon", () => {
    expect(SRC).toContain("Bell,");
    expect(SRC).toMatch(/import\s*\{[^}]*Bell[^}]*\}\s*from\s*["']lucide-react["']/);
  });

  it("renders a 'Manage reminders' link pointing to /reminders/manage", () => {
    expect(SRC).toContain('href="/reminders/manage"');
    expect(SRC).toContain('data-testid="account-link-reminders-manage"');
  });

  it("renders a 'Set up new' link pointing to /reminders", () => {
    // Use a reminders-specific testid so the generic /reminders href doesn't
    // accidentally match an unrelated element on the page.
    expect(SRC).toContain('data-testid="account-link-reminders-signup"');
    // Verify both testids are near /reminders and /reminders/manage hrefs.
    const signupIdx = SRC.indexOf('data-testid="account-link-reminders-signup"');
    const signupContext = SRC.slice(signupIdx - 400, signupIdx + 100);
    expect(signupContext).toContain('href="/reminders"');
  });

  it("uses Link (SPA navigation) for both reminders targets", () => {
    const manageIdx = SRC.indexOf('data-testid="account-link-reminders-manage"');
    const signupIdx = SRC.indexOf('data-testid="account-link-reminders-signup"');
    // Both elements must appear inside a <Link> wrapper.
    const manageContext = SRC.slice(manageIdx - 300, manageIdx + 50);
    const signupContext = SRC.slice(signupIdx - 300, signupIdx + 50);
    expect(manageContext).toContain("Link");
    expect(signupContext).toContain("Link");
  });

  it("does NOT issue a live API fetch to the manage endpoint from /account", () => {
    // The section comment explicitly documents that probing the manage endpoint
    // was intentionally omitted to avoid doubling the page fan-out.
    expect(SRC).not.toContain("useGetReminderSubscription");
    expect(SRC).not.toMatch(/fetch\(.*reminders\/manage/);
  });

  it("uses glass-card styling matching the other account tiles", () => {
    const sectionIdx = SRC.indexOf('data-testid="account-reminders-section"');
    const sectionContext = SRC.slice(sectionIdx, sectionIdx + 400);
    expect(sectionContext).toContain("glass-card");
  });

  it("uses outline variant for the primary Manage reminders button", () => {
    const manageIdx = SRC.indexOf('data-testid="account-link-reminders-manage"');
    const manageContext = SRC.slice(manageIdx - 400, manageIdx + 50);
    expect(manageContext).toContain('variant="outline"');
  });

  it("uses ghost variant for the secondary Set up new button", () => {
    const signupIdx = SRC.indexOf('data-testid="account-link-reminders-signup"');
    const signupContext = SRC.slice(signupIdx - 400, signupIdx + 50);
    expect(signupContext).toContain('variant="ghost"');
  });

  it("renders the section heading 'Replacement reminders'", () => {
    expect(SRC).toContain("Replacement reminders");
  });

  it("includes copy that communicates the skip-inbox benefit", () => {
    // This copy must stay — it's the primary value proposition for the tile.
    expect(SRC).toContain("Skip the inbox round-trip");
  });
});

// ---------------------------------------------------------------------------
// RemindersSection ordering — placement regression
// ---------------------------------------------------------------------------
// The tile must appear BEFORE SubscriptionsSection (insurance-specific) and
// AFTER ReorderSuggestionsSection so the most accessible self-service action
// for non-insurance patients ranks appropriately in the page flow.

describe("account — RemindersSection placement regression", () => {
  it("appears before SubscriptionsSection in the source order", () => {
    const remindersIdx = SRC.indexOf("<RemindersSection />");
    const subscriptionsIdx = SRC.indexOf("<SubscriptionsSection");
    expect(remindersIdx).toBeGreaterThan(-1);
    expect(subscriptionsIdx).toBeGreaterThan(-1);
    expect(remindersIdx).toBeLessThan(subscriptionsIdx);
  });

  it("appears after ReorderSuggestionsSection in the source order", () => {
    const reorderIdx = SRC.indexOf("<ReorderSuggestionsSection />");
    const remindersIdx = SRC.indexOf("<RemindersSection />");
    expect(reorderIdx).toBeGreaterThan(-1);
    expect(remindersIdx).toBeGreaterThan(-1);
    expect(remindersIdx).toBeGreaterThan(reorderIdx);
  });
});