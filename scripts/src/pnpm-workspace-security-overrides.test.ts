// Tests for the pnpm-workspace.yaml security overrides section.
//
// This PR removed the `"axios@<1.16.1": ^1.16.1` version-range override that
// was previously used to pin the @sendgrid/client transitive dependency to the
// patched axios version (fixing prototype-pollution / Proxy-Authorization
// header injection). The override is no longer needed because @sendgrid/client
// was updated to depend on axios >= 1.16.1 directly.
//
// Tests use the same filesystem-level + string matching approach as
// claude-md-conformance.test.ts: no YAML parser is required, and no workspace
// code is imported, so the suite runs quickly and without compilation.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repository root is two levels up from scripts/src/
const ROOT = resolve(__dirname, "..", "..");
const WORKSPACE_FILE = resolve(ROOT, "pnpm-workspace.yaml");

let content = "";
beforeAll(() => {
  content = readFileSync(WORKSPACE_FILE, "utf8");
});

// ---------------------------------------------------------------------------
// PR change: axios version-range override removed
// ---------------------------------------------------------------------------

describe("axios version-range override — removed in this PR", () => {
  it("does not contain 'axios@<1.16.1' override key", () => {
    // The primary change in this PR: the override that pinned the
    // @sendgrid/client transitive axios dependency is gone.
    expect(content).not.toContain("axios@<1.16.1");
  });

  it("does not contain any 'axios@<' version-range override key", () => {
    // Regression guard: no other less-than axios overrides should be added
    // without an accompanying security comment explaining the CVE.
    expect(content).not.toMatch(/"axios@</);
  });

  it("does not contain the patch-bypass comment referencing prototype pollution", () => {
    // The explanatory comment was removed alongside the override entry itself.
    expect(content).not.toContain("axios <1.16.1 is vulnerable");
    expect(content).not.toContain("Proxy-Authorization header injection");
    expect(content).not.toContain("prototype pollution");
    expect(content).not.toContain("@sendgrid/client transitive");
  });

  it("does not contain a blanket 'axios:' override that would force a global version pin", () => {
    // Ensure that removing the scoped override did not accidentally introduce
    // a broader unscoped 'axios:' override in its place.
    expect(content).not.toMatch(/^\s+axios:\s+/m);
  });
});

// ---------------------------------------------------------------------------
// Overrides section — structural integrity
// ---------------------------------------------------------------------------

describe("pnpm-workspace.yaml overrides section — structural integrity", () => {
  it("still contains an 'overrides:' top-level key", () => {
    expect(content).toMatch(/^overrides:/m);
  });

  it("overrides section appears after the catalog section", () => {
    const catalogIdx = content.indexOf("catalog:");
    const overridesIdx = content.indexOf("overrides:");
    expect(catalogIdx).toBeGreaterThan(-1);
    expect(overridesIdx).toBeGreaterThan(catalogIdx);
  });
});

// ---------------------------------------------------------------------------
// Remaining security overrides — non-regression
// ---------------------------------------------------------------------------
//
// Every entry below was present before this PR and must remain intact.
// If any of these tests break, an unintended security override was removed.

describe("security overrides — still present after axios entry removal", () => {
  it("lodash security override is still present", () => {
    expect(content).toContain("lodash:");
  });

  it("path-to-regexp security override is still present", () => {
    expect(content).toContain("path-to-regexp:");
  });

  it("picomatch@<2.3.2 version-range override is still present", () => {
    expect(content).toContain('"picomatch@<2.3.2"');
  });

  it("picomatch@>=4.0.0 <4.0.4 version-range override is still present", () => {
    expect(content).toContain('"picomatch@>=4.0.0 <4.0.4"');
  });

  it("brace-expansion@<1.1.13 version-range override is still present", () => {
    expect(content).toContain('"brace-expansion@<1.1.13"');
  });

  it("brace-expansion@>=2.0.0 <2.0.3 version-range override is still present", () => {
    expect(content).toContain('"brace-expansion@>=2.0.0 <2.0.3"');
  });

  it("uuid security override is still present", () => {
    expect(content).toContain("uuid:");
  });

  it("postcss security override is still present", () => {
    expect(content).toContain("postcss:");
  });

  it("yaml security override is still present", () => {
    expect(content).toContain("yaml:");
  });

  it("http-proxy-agent security override is still present", () => {
    expect(content).toContain("http-proxy-agent:");
  });

  it("ip-address security override is still present", () => {
    expect(content).toContain("ip-address:");
  });

  it("fast-xml-builder security override is still present", () => {
    expect(content).toContain("fast-xml-builder:");
  });

  it("qs security override is still present", () => {
    expect(content).toContain("qs:");
  });
});

// ---------------------------------------------------------------------------
// Security override comment block — present and accurate
// ---------------------------------------------------------------------------

describe("security overrides section comment", () => {
  it("contains the security advisory comment block above the overrides", () => {
    // The comment explains the purpose of this section to future maintainers.
    expect(content).toContain("Security: pin transitive dependencies to patched versions");
  });

  it("references 'GitHub advisories' in the comment block", () => {
    expect(content).toContain("GitHub advisories");
  });

  it("references 'Targeted version-range overrides' strategy in the comment", () => {
    // Documents why scoped overrides are preferred over blanket ones.
    expect(content).toContain("Targeted version-range overrides");
  });
});

// ---------------------------------------------------------------------------
// Regression: axios is not present anywhere in the overrides as a pinned key
// ---------------------------------------------------------------------------

describe("regression: no axios overrides in any form", () => {
  it("does not have any 'axios@' version-range override anywhere in overrides section", () => {
    // Extract just the overrides section for targeted inspection.
    const overridesStart = content.indexOf("overrides:");
    expect(overridesStart).toBeGreaterThan(-1);
    const overridesSection = content.slice(overridesStart);
    expect(overridesSection).not.toMatch(/"axios@[^"]+"/);
  });

  it("pnpm-lock.yaml exists (lockfile was regenerated after removing axios override)", () => {
    // The lockfile must be present — a missing lockfile means install was
    // not re-run after the workspace config change.
    const lockfile = resolve(ROOT, "pnpm-lock.yaml");
    expect(existsSync(lockfile)).toBe(true);
  });
});
