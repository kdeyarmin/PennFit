import { beforeEach, describe, expect, it } from "vitest";

import {
  PATIENT_HELP_DOCS,
  buildInviteHelpAttachments,
  staffHelpDocs,
  __clearHelpDocCache,
} from "./index";

beforeEach(() => {
  __clearHelpDocCache();
});

describe("staffHelpDocs", () => {
  it("gives admins the getting-started guide plus the administrator guide", () => {
    const docs = staffHelpDocs("admin");
    expect(docs.map((d) => d.key)).toEqual([
      "staff-getting-started",
      "staff-administrator-guide",
    ]);
  });

  it("gives non-admin staff only the getting-started guide", () => {
    for (const role of [
      "csr",
      "agent",
      "fitter",
      "fulfillment",
      "supervisor",
      "rt",
      "compliance_officer",
    ] as const) {
      const docs = staffHelpDocs(role);
      expect(docs.map((d) => d.key)).toEqual(["staff-getting-started"]);
    }
  });
});

describe("buildInviteHelpAttachments", () => {
  it("renders patient help docs as PDF attachments", async () => {
    const attachments = await buildInviteHelpAttachments({ kind: "patient" });
    expect(attachments).toHaveLength(PATIENT_HELP_DOCS.length);
    const a = attachments[0]!;
    expect(a.filename).toBe("PennPaps-Patient-Portal-Guide.pdf");
    expect(a.contentType).toBe("application/pdf");
    // PDF magic bytes.
    expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(a.content.length).toBeGreaterThan(500);
  });

  it("renders both admin staff docs", async () => {
    const attachments = await buildInviteHelpAttachments({
      kind: "staff",
      role: "admin",
    });
    expect(attachments.map((a) => a.filename)).toEqual([
      "PennPaps-Team-Getting-Started.pdf",
      "PennPaps-Administrator-Guide.pdf",
    ]);
    for (const a of attachments) {
      expect(a.contentType).toBe("application/pdf");
      expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("renders a single doc for a non-admin staff role", async () => {
    const attachments = await buildInviteHelpAttachments({
      kind: "staff",
      role: "csr",
    });
    expect(attachments.map((a) => a.filename)).toEqual([
      "PennPaps-Team-Getting-Started.pdf",
    ]);
  });

  it("caches rendered bytes across calls (same buffer reused)", async () => {
    const first = await buildInviteHelpAttachments({ kind: "patient" });
    const second = await buildInviteHelpAttachments({ kind: "patient" });
    // Same cached Buffer instance is reused for the rendered document.
    expect(second[0]!.content).toBe(first[0]!.content);
  });
});
