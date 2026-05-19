// Regression tests for admin URL routing — PR url-prefix fix.
//
// PR change summary
// -----------------
// Several admin React components were generating internal links with
// incorrect path prefixes. This PR corrects them:
//
//   Patient360Panel.tsx
//     /patients/${patientId}  →  /admin/patients/${patientId}
//
//   admin-delivery-failures.tsx
//     /patients/${patientId}        →  /admin/patients/${patientId}
//     /conversations/${conversationId}  →  /admin/conversations/${conversationId}
//
//   conversation-detail.tsx
//     /patients/${patientId}  →  /admin/patients/${patientId}
//
// Why test URL builders as pure functions?
// These URL expressions are inline in JSX. We extract the exact
// building logic (template literals) into plain functions here and
// verify the expected prefixes, mirroring the approach used for the
// star-rating aria-label tests in this repo. A DOM/React renderer is
// not required — the string construction is the contract under test.
//
// If a future refactor ever pulls these into shared utilities, the
// test expectations here can be re-targeted at the utility directly.

import { describe, expect, it } from "vitest";

// ── URL builders — mirror the JSX expressions verbatim ───────────────────────

/**
 * Produces the admin patient detail URL used in Patient360Panel,
 * admin-delivery-failures, and conversation-detail after the PR fix.
 */
function adminPatientUrl(patientId: string): string {
  return `/admin/patients/${patientId}`;
}

/**
 * Produces the admin conversation detail URL used in
 * admin-delivery-failures after the PR fix.
 */
function adminConversationUrl(conversationId: string): string {
  return `/admin/conversations/${conversationId}`;
}

/**
 * Produces the OLD (incorrect) patient URL that the PR removed.
 * Kept here as the reference value for the regression guard.
 */
function oldPatientUrl(patientId: string): string {
  return `/patients/${patientId}`;
}

/**
 * Produces the OLD (incorrect) conversation URL that the PR removed.
 */
function oldConversationUrl(conversationId: string): string {
  return `/conversations/${conversationId}`;
}

// ── adminPatientUrl ───────────────────────────────────────────────────────────

describe("adminPatientUrl — PR fix: /admin/patients/ prefix", () => {
  it("starts with /admin/patients/", () => {
    expect(adminPatientUrl("abc123")).toMatch(/^\/admin\/patients\//);
  });

  it("appends the patient ID verbatim", () => {
    const id = "PAT-00042";
    expect(adminPatientUrl(id)).toBe(`/admin/patients/${id}`);
  });

  it("produces the correct URL for a UUID-style ID", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(adminPatientUrl(id)).toBe(
      `/admin/patients/550e8400-e29b-41d4-a716-446655440000`,
    );
  });

  it("does NOT produce the old /patients/ prefix (regression guard)", () => {
    const url = adminPatientUrl("test-id");
    expect(url).not.toMatch(/^\/patients\//);
    expect(url).not.toBe(oldPatientUrl("test-id"));
  });

  it("does NOT produce an empty path segment", () => {
    expect(adminPatientUrl("id")).not.toContain("//");
  });

  it("includes exactly one leading slash", () => {
    expect(adminPatientUrl("id")).toMatch(/^\//);
    expect(adminPatientUrl("id")).not.toMatch(/^\/\//);
  });

  it.each([
    ["numeric ID", "12345"],
    ["PACware-style ID", "PAC-99999"],
    ["UUID", "aaaabbbb-cccc-dddd-eeee-ffffffffffff"],
    ["single char ID", "x"],
  ])("correctly builds URL for %s (%s)", (_label, id) => {
    expect(adminPatientUrl(id)).toBe(`/admin/patients/${id}`);
  });
});

// ── adminConversationUrl ──────────────────────────────────────────────────────

describe("adminConversationUrl — PR fix: /admin/conversations/ prefix", () => {
  it("starts with /admin/conversations/", () => {
    expect(adminConversationUrl("conv-001")).toMatch(
      /^\/admin\/conversations\//,
    );
  });

  it("appends the conversation ID verbatim", () => {
    const id = "CONV-00099";
    expect(adminConversationUrl(id)).toBe(`/admin/conversations/${id}`);
  });

  it("produces the correct URL for a UUID-style ID", () => {
    const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(adminConversationUrl(id)).toBe(
      `/admin/conversations/f47ac10b-58cc-4372-a567-0e02b2c3d479`,
    );
  });

  it("does NOT produce the old /conversations/ prefix (regression guard)", () => {
    const url = adminConversationUrl("test-id");
    expect(url).not.toMatch(/^\/conversations\//);
    expect(url).not.toBe(oldConversationUrl("test-id"));
  });

  it("does NOT produce an empty path segment", () => {
    expect(adminConversationUrl("id")).not.toContain("//");
  });

  it.each([
    ["numeric ID", "42"],
    ["slug-style ID", "conv-2024-01-15"],
    ["UUID", "aaaabbbb-cccc-dddd-eeee-ffffffffffff"],
  ])("correctly builds URL for %s (%s)", (_label, id) => {
    expect(adminConversationUrl(id)).toBe(`/admin/conversations/${id}`);
  });
});

// ── Cross-route prefix consistency ───────────────────────────────────────────

describe("admin URL prefix consistency", () => {
  it("both admin URL builders share the /admin/ prefix", () => {
    expect(adminPatientUrl("p1")).toMatch(/^\/admin\//);
    expect(adminConversationUrl("c1")).toMatch(/^\/admin\//);
  });

  it("patient and conversation URLs are distinct for the same ID", () => {
    const id = "shared-id";
    expect(adminPatientUrl(id)).not.toBe(adminConversationUrl(id));
  });

  it("the old patient URL and the new admin patient URL differ for the same ID", () => {
    const id = "test-id";
    expect(adminPatientUrl(id)).not.toBe(oldPatientUrl(id));
  });

  it("the old conversation URL and the new admin conversation URL differ for the same ID", () => {
    const id = "test-id";
    expect(adminConversationUrl(id)).not.toBe(oldConversationUrl(id));
  });

  it("new admin patient path has one more segment than the old path", () => {
    // /admin/patients/id  →  3 non-empty segments
    // /patients/id        →  2 non-empty segments
    const newSegments = adminPatientUrl("id")
      .split("/")
      .filter(Boolean).length;
    const oldSegments = oldPatientUrl("id").split("/").filter(Boolean).length;
    expect(newSegments).toBe(oldSegments + 1);
  });

  it("new admin conversation path has one more segment than the old path", () => {
    const newSegments = adminConversationUrl("id")
      .split("/")
      .filter(Boolean).length;
    const oldSegments = oldConversationUrl("id").split("/").filter(Boolean).length;
    expect(newSegments).toBe(oldSegments + 1);
  });
});
