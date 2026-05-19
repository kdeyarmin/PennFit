// Static guard for the /admin/ prefix fixes applied in this PR.
//
// Three components had patient/conversation links with incorrect prefixes:
//
//   Patient360Panel.tsx        /patients/:id         → /admin/patients/:id
//   admin-delivery-failures.tsx /patients/:id        → /admin/patients/:id
//                               /conversations/:id   → /admin/conversations/:id
//   conversation-detail.tsx    /patients/:id         → /admin/patients/:id
//
// Rendering these components requires jsdom + React which the current
// vitest config doesn't enable.  We read the source files directly and
// assert that:
//   a) the corrected /admin/* patterns are present, and
//   b) the previously incorrect bare /patients/ and /conversations/ hrefs
//      are absent.
//
// This mirrors the approach used in admin.scope.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSrc(relPath: string): string {
  return readFileSync(path.resolve(__dirname, relPath), "utf8");
}

// We load sources relative to this file's directory.
const PATIENT360_SRC = readSrc("Patient360Panel.tsx");
const DELIVERY_FAILURES_SRC = readSrc(
  "../../pages/admin/admin-delivery-failures.tsx",
);
const CONVERSATION_DETAIL_SRC = readSrc(
  "../../pages/admin/conversation-detail.tsx",
);

// ---------------------------------------------------------------------------
// Patient360Panel.tsx
// ---------------------------------------------------------------------------
describe("Patient360Panel — patient profile link prefix", () => {
  it("links to /admin/patients/:patientId (correct admin prefix)", () => {
    expect(PATIENT360_SRC).toContain("/admin/patients/${patientId}");
  });

  it("does not link to the bare /patients/:patientId (no admin prefix)", () => {
    // Regression: the old href was /patients/${patientId} which would 404
    // when used inside the admin app.
    // We check that no href template literal starts with /patients/ directly.
    // Allow the /admin/patients/ form but reject bare /patients/.
    const barePatientLink = /href=\{`\/patients\/\$/;
    expect(PATIENT360_SRC).not.toMatch(barePatientLink);
  });
});

// ---------------------------------------------------------------------------
// admin-delivery-failures.tsx
// ---------------------------------------------------------------------------
describe("admin-delivery-failures — patient and conversation link prefixes", () => {
  it("links patient rows to /admin/patients/:patientId", () => {
    expect(DELIVERY_FAILURES_SRC).toContain("/admin/patients/${row.patientId}");
  });

  it("does not link patient rows to bare /patients/:patientId", () => {
    const barePatientLink = /href=\{`\/patients\/\$/;
    expect(DELIVERY_FAILURES_SRC).not.toMatch(barePatientLink);
  });

  it("links conversation cells to /admin/conversations/:conversationId", () => {
    expect(DELIVERY_FAILURES_SRC).toContain(
      "/admin/conversations/${row.conversationId}",
    );
  });

  it("does not link conversation cells to bare /conversations/:conversationId", () => {
    const bareConversationLink = /href=\{`\/conversations\/\$/;
    expect(DELIVERY_FAILURES_SRC).not.toMatch(bareConversationLink);
  });
});

// ---------------------------------------------------------------------------
// conversation-detail.tsx
// ---------------------------------------------------------------------------
describe("conversation-detail — patient profile link prefix", () => {
  it("links to /admin/patients/:patientId (correct admin prefix)", () => {
    expect(CONVERSATION_DETAIL_SRC).toContain(
      "/admin/patients/${data.patientId}",
    );
  });

  it("does not link to the bare /patients/:patientId (no admin prefix)", () => {
    const barePatientLink = /href=\{`\/patients\/\$/;
    expect(CONVERSATION_DETAIL_SRC).not.toMatch(barePatientLink);
  });
});

// ---------------------------------------------------------------------------
// Cross-file: all three files use /admin/ prefix, not bare paths
// ---------------------------------------------------------------------------
describe("admin link prefix consistency across all three changed files", () => {
  const files: Array<{ name: string; src: string }> = [
    { name: "Patient360Panel.tsx", src: PATIENT360_SRC },
    { name: "admin-delivery-failures.tsx", src: DELIVERY_FAILURES_SRC },
    { name: "conversation-detail.tsx", src: CONVERSATION_DETAIL_SRC },
  ];

  for (const { name, src } of files) {
    it(`${name}: every patient link template literal uses /admin/patients/ prefix`, () => {
      // Extract all href template literal content from the file.
      // Match patterns like: href={`/patients/...`} (incorrect)
      const bareHrefPattern = /href=\{`\/patients\//g;
      expect(src).not.toMatch(bareHrefPattern);
    });
  }
});