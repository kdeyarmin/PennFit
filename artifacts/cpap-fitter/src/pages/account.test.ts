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
    expect(SUBS_SRC).toContain(
      'data-testid="account-subscription-action-error"',
    );
  });

  it("account-subscription-action-error element does not carry role=alert", () => {
    const idx = SUBS_SRC.indexOf(
      'data-testid="account-subscription-action-error"',
    );
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
    const elementContext = SUBS_SRC.slice(
      idx - 80,
      idx + errorText.length + 20,
    );
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
    const shopApiImport = SRC.match(
      /import\s*\{[^}]*\}\s*from\s*["']@\/lib\/shop-api["']/,
    );
    expect(shopApiImport).not.toBeNull();
    expect(shopApiImport![0]).not.toContain("formatMoneyCents");
  });

  it("shop-api import contains exactly one exported name (fetchShopProducts only)", () => {
    // After the PR the brace-group must contain only fetchShopProducts —
    // no trailing comma or second identifier.
    const shopApiImport = SRC.match(
      /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/shop-api["']/,
    );
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
// Tabbed account navigation — the ~20-section scroll is now five tabs.
// ---------------------------------------------------------------------------
describe("account — sections grouped into tabs", () => {
  it("defines an AccountTabBar with the five tab ids", () => {
    expect(SRC).toContain("function AccountTabBar");
    expect(SRC).toContain("const ACCOUNT_TABS");
    for (const id of ["overview", "orders", "therapy", "messages", "account"]) {
      expect(SRC).toContain(`id: "${id}"`);
    }
  });

  it("renders a tablist with per-tab testids", () => {
    expect(SRC).toContain('data-testid="account-tabs"');
    expect(SRC).toContain("account-tab-");
    expect(SRC).toContain('role="tablist"');
  });

  it("keeps deep links working via hashToAccountTab + a hashchange listener", () => {
    expect(SRC).toContain("function hashToAccountTab");
    expect(SRC).toContain('if (h === "messages") return "messages"');
    expect(SRC).toContain('if (h === "autoship") return "orders"');
    expect(SRC).toContain('addEventListener("hashchange"');
  });

  it("badges the Messages tab from the unread hook", () => {
    expect(SRC).toContain("useShopMessagesUnread");
    expect(SRC).toContain("account-tab-messages-badge");
  });

  it("still renders every section, now behind a tab", () => {
    const tags = [
      "<PushPromptBanner",
      "<ProfileSection",
      "<ClinicalInfoSection",
      "<InsightsSection",
      "<ReorderSuggestionsSection",
      "<SubscriptionsSection",
      "<OrdersSection",
      "<MyReturnsSection",
      "<SubstitutionsSection",
      "<TherapySummarySection",
      "<MaintenanceSection",
      "<MaskLeakWizardSection",
      "<EducationFeedSection",
      "<EquipmentRegistrySection",
      "<AccountMessagesSection",
      "<CustomerChatSection",
      "<DocumentsSection",
      "<EsignFormsSection",
      "<ReferralProgramSection",
      "<CaregiverSection",
      "<WalletPassSection",
      "<CommPrefsSection",
      "<DataExportSection",
    ];
    for (const tag of tags) {
      expect(SRC).toContain(tag);
    }
  });
});

// Pure-logic mirror of hashToAccountTab (kept verbatim with account.tsx).
describe("hashToAccountTab", () => {
  function hashToAccountTab(hash: string): "messages" | "orders" | null {
    const h = hash.replace(/^#/, "");
    if (h === "messages") return "messages";
    if (h === "autoship") return "orders";
    return null;
  }

  it("maps #messages → Messages tab", () => {
    expect(hashToAccountTab("#messages")).toBe("messages");
  });

  it("maps #autoship → Orders & returns tab", () => {
    expect(hashToAccountTab("#autoship")).toBe("orders");
  });

  it("returns null for empty / unknown hashes (defaults to Overview)", () => {
    expect(hashToAccountTab("")).toBeNull();
    expect(hashToAccountTab("#whatever")).toBeNull();
  });
});
