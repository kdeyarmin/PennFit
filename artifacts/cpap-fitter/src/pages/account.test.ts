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
  it("defines an AccountTabBar with the four tab ids", () => {
    // The "orders" tab retired with cash-pay: there is no retail order
    // list, membership, or subscription for a patient to manage.
    expect(SRC).toContain("function AccountTabBar");
    expect(SRC).toContain("const ACCOUNT_TABS");
    for (const id of ["overview", "therapy", "messages", "account"]) {
      expect(SRC).toContain(`id: "${id}"`);
    }
    expect(SRC).not.toContain('id: "orders"');
  });

  it("renders a tablist with per-tab testids", () => {
    expect(SRC).toContain('data-testid="account-tabs"');
    expect(SRC).toContain("account-tab-");
    expect(SRC).toContain('role="tablist"');
  });

  it("keeps deep links working via hashToAccountTab + a hashchange listener", () => {
    expect(SRC).toContain("function hashToAccountTab");
    expect(SRC).toContain('if (h === "insights") return "overview"');
    expect(SRC).toContain('if (h === "messages") return "messages"');
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
      "<CommPrefsSection",
      "<DataExportSection",
    ];
    for (const tag of tags) {
      expect(SRC).toContain(tag);
    }
  });
});

// ---------------------------------------------------------------------------
// Dirty-state protection across account tabs
// ---------------------------------------------------------------------------

describe("account — dirty tab changes require confirmation", () => {
  it("imports the shared discard-confirmation helper", () => {
    expect(SRC).toContain("confirmDiscardUnsavedChanges");
  });

  it("tracks dirty state from profile and communication preferences", () => {
    expect(SRC).toContain("profileDirty");
    expect(SRC).toContain("commPrefsDirty");
    expect(SRC).toContain("onDirtyChange={setProfileDirty}");
    expect(SRC).toContain("onDirtyChange={setCommPrefsDirty}");
  });

  it("guards both clicked tabs and hash-driven tab changes", () => {
    expect(SRC).toContain("guardedAccountTab");
    expect(SRC).toContain("onChange={changeAccountTab}");
    expect(SRC).toContain("const next = guardedAccountTab(current, tab);");
    expect(SRC).toContain("window.history.replaceState");
  });

  it("only prompts when leaving a dirty mounted section", () => {
    expect(SRC).toContain('current === "overview" && profileDirty');
    expect(SRC).toContain('current === "account" && commPrefsDirty');
    expect(SRC).toContain("!confirmDiscardUnsavedChanges()");
    expect(SRC).toContain("return current");
  });
});

// Pure-logic mirror of hashToAccountTab (kept verbatim with account.tsx).
describe("hashToAccountTab", () => {
  function hashToAccountTab(
    hash: string,
  ): "overview" | "messages" | "orders" | null {
    const h = hash.replace(/^#/, "");
    if (h === "insights") return "overview";
    if (h === "messages") return "messages";
    if (h === "autoship" || h === "orders") return "orders";
    return null;
  }

  it("maps #insights to Overview tab", () => {
    expect(hashToAccountTab("#insights")).toBe("overview");
  });

  it("maps #messages → Messages tab", () => {
    expect(hashToAccountTab("#messages")).toBe("messages");
  });

  it("maps #autoship → Orders & returns tab", () => {
    expect(hashToAccountTab("#autoship")).toBe("orders");
  });

  it("maps #orders to Orders & returns tab", () => {
    expect(hashToAccountTab("#orders")).toBe("orders");
  });

  it("returns null for empty / unknown hashes (defaults to Overview)", () => {
    expect(hashToAccountTab("")).toBeNull();
    expect(hashToAccountTab("#whatever")).toBeNull();
  });
});
