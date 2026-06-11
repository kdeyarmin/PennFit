import { beforeEach, describe, expect, it } from "vitest";

import {
  CUSTOMER_SERVICE_MANUAL_FILENAME,
  PATIENT_HELP_DOCS,
  buildInviteHelpAttachments,
  loadCustomerServiceManual,
  staffHelpDocs,
  __clearHelpDocCache,
  __clearManualCache,
} from "./index";

beforeEach(() => {
  __clearHelpDocCache();
  __clearManualCache();
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

  it("renders both admin staff docs plus the customer service manual", async () => {
    const attachments = await buildInviteHelpAttachments({
      kind: "staff",
      role: "admin",
    });
    expect(attachments.map((a) => a.filename)).toEqual([
      "PennPaps-Team-Getting-Started.pdf",
      "PennPaps-Administrator-Guide.pdf",
      CUSTOMER_SERVICE_MANUAL_FILENAME,
    ]);
    for (const a of attachments) {
      expect(a.contentType).toBe("application/pdf");
      expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("gives a non-admin staff role the guide plus the manual", async () => {
    const attachments = await buildInviteHelpAttachments({
      kind: "staff",
      role: "csr",
    });
    expect(attachments.map((a) => a.filename)).toEqual([
      "PennPaps-Team-Getting-Started.pdf",
      CUSTOMER_SERVICE_MANUAL_FILENAME,
    ]);
  });

  it("does not attach the manual to patient or provider invites", async () => {
    for (const audience of [
      { kind: "patient" } as const,
      { kind: "provider" } as const,
    ]) {
      const attachments = await buildInviteHelpAttachments(audience);
      expect(attachments.map((a) => a.filename)).not.toContain(
        CUSTOMER_SERVICE_MANUAL_FILENAME,
      );
    }
  });

  it("renders the provider portal guide for provider invites", async () => {
    const attachments = await buildInviteHelpAttachments({ kind: "provider" });
    expect(attachments.map((a) => a.filename)).toEqual([
      "PennPaps-Provider-Portal-Guide.pdf",
    ]);
    const a = attachments[0]!;
    expect(a.contentType).toBe("application/pdf");
    expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(a.content.length).toBeGreaterThan(500);
  });

  it("caches rendered bytes across calls (same buffer reused)", async () => {
    const first = await buildInviteHelpAttachments({ kind: "patient" });
    const second = await buildInviteHelpAttachments({ kind: "patient" });
    // Same cached Buffer instance is reused for the rendered document.
    expect(second[0]!.content).toBe(first[0]!.content);
  });
});

describe("loadCustomerServiceManual", () => {
  it("loads the repo's pre-rendered manual PDF and caches it", async () => {
    const manual = await loadCustomerServiceManual();
    expect(manual).not.toBeNull();
    expect(manual!.filename).toBe(CUSTOMER_SERVICE_MANUAL_FILENAME);
    expect(manual!.contentType).toBe("application/pdf");
    expect(manual!.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(manual!.content.length).toBeGreaterThan(100_000);

    const again = await loadCustomerServiceManual();
    expect(again!.content).toBe(manual!.content);
  });
});
