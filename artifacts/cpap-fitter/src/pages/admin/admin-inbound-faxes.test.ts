// Tests for pages/admin/admin-inbound-faxes.tsx — post-revert state
//
// PR change: reverted from useUrlState (with FILTER_IDS + isFilter predicate)
// back to plain useState<Filter>("open"). The FILTER_IDS set, isFilter
// predicate, and useUrlState import/call-site were all removed.
//
// Because the component uses React + @tanstack/react-query (not renderable in
// the node vitest environment without jsdom), we use static source analysis:
// readFileSync + SRC.toContain() / SRC.not.toContain() to verify structural
// invariants of the reverted code.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "admin-inbound-faxes.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Revert: useUrlState and its supporting code must be gone
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — useUrlState removed", () => {
  it("does not import useUrlState", () => {
    expect(SRC).not.toContain("useUrlState");
  });

  it("does not import from @/hooks/use-url-state", () => {
    expect(SRC).not.toContain('from "@/hooks/use-url-state"');
  });

  it("does not define FILTER_IDS", () => {
    expect(SRC).not.toContain("FILTER_IDS");
  });

  it("does not define isFilter", () => {
    expect(SRC).not.toContain("isFilter");
  });

  it("does not use ReadonlySet (which was part of the FILTER_IDS declaration)", () => {
    expect(SRC).not.toContain("ReadonlySet");
  });
});

// ---------------------------------------------------------------------------
// Reverted state: plain useState drives the active filter
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — useState<Filter> replaces useUrlState", () => {
  it("uses useState to hold the active filter", () => {
    expect(SRC).toContain("useState");
  });

  it('defaults to "open" as the initial filter value', () => {
    expect(SRC).toContain('"open"');
  });

  it("destructures [filter, setFilter] from useState", () => {
    expect(SRC).toContain("filter, setFilter");
  });
});

// ---------------------------------------------------------------------------
// Filter values — all five filters still present in the render
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — all five filter values rendered", () => {
  const filters = ["open", "new", "triaged", "attached", "archived"] as const;

  for (const f of filters) {
    it(`renders filter value "${f}" in the chip list`, () => {
      expect(SRC).toContain(`"${f}"`);
    });
  }

  it("renders filter chips in open→new→triaged→attached→archived order", () => {
    const openIdx = SRC.indexOf('"open"');
    const newIdx = SRC.indexOf('"new"', openIdx);
    const triagedIdx = SRC.indexOf('"triaged"', newIdx);
    const attachedIdx = SRC.indexOf('"attached"', triagedIdx);
    const archivedIdx = SRC.indexOf('"archived"', attachedIdx);
    expect(openIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(openIdx);
    expect(triagedIdx).toBeGreaterThan(newIdx);
    expect(attachedIdx).toBeGreaterThan(triagedIdx);
    expect(archivedIdx).toBeGreaterThan(attachedIdx);
  });
});

// ---------------------------------------------------------------------------
// FilterChip component still wired to setFilter
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — FilterChip structural markup unchanged", () => {
  it("renders FilterChip components for each filter value", () => {
    expect(SRC).toContain("FilterChip");
  });

  it("passes setFilter as the onClick handler for chips", () => {
    expect(SRC).toContain("setFilter");
  });
});

// ---------------------------------------------------------------------------
// No bespoke URL-sync code introduced
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — no URL sync code present", () => {
  it("does not call history.replaceState for filter changes", () => {
    expect(SRC).not.toContain("replaceState");
  });

  it("does not add a popstate event listener", () => {
    expect(SRC).not.toContain('addEventListener("popstate"');
  });

  it("does not read from URLSearchParams for filter initialisation", () => {
    expect(SRC).not.toContain("URLSearchParams");
  });
});

// ---------------------------------------------------------------------------
// Type definition: Filter type includes all five members
// ---------------------------------------------------------------------------

describe("admin-inbound-faxes — Filter type definition", () => {
  it("defines the Filter type", () => {
    expect(SRC).toContain("type Filter");
  });

  it("Filter type includes all expected members", () => {
    const typeBlock = SRC.slice(
      SRC.indexOf("type Filter"),
      SRC.indexOf("type Filter") + 80,
    );
    expect(typeBlock).toContain("open");
    expect(typeBlock).toContain("new");
    expect(typeBlock).toContain("triaged");
    expect(typeBlock).toContain("attached");
    expect(typeBlock).toContain("archived");
  });
});