import { beforeEach, describe, expect, it } from "vitest";

import {
  CUSTOMER_SERVICE_MANUAL_FILENAME,
  patientHelpDocs,
  providerHelpDocs,
  buildInviteHelpAttachments,
  loadCustomerServiceManual,
  staffHelpDocs,
  __clearHelpDocCache,
  __clearManualCache,
} from "./index";

/** A tenant that is deliberately NOT the seed tenant. */
const CO = "Northwind Respiratory";

beforeEach(() => {
  __clearHelpDocCache();
  __clearManualCache();
});

describe("staffHelpDocs", () => {
  it("gives admins the getting-started guide plus the administrator guide", () => {
    const docs = staffHelpDocs("admin", CO);
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
      const docs = staffHelpDocs(role, CO);
      expect(docs.map((d) => d.key)).toEqual(["staff-getting-started"]);
    }
  });
});

describe("buildInviteHelpAttachments", () => {
  it("renders patient help docs as PDF attachments", async () => {
    const attachments = await buildInviteHelpAttachments(
      { kind: "patient" },
      CO,
    );
    expect(attachments).toHaveLength(patientHelpDocs(CO).length);
    const a = attachments[0]!;
    expect(a.filename).toBe(`${CO}-Patient-Portal-Guide.pdf`);
    expect(a.contentType).toBe("application/pdf");
    // PDF magic bytes.
    expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(a.content.length).toBeGreaterThan(500);
  });

  it("renders both admin staff docs plus the customer service manual", async () => {
    const attachments = await buildInviteHelpAttachments(
      {
        kind: "staff",
        role: "admin",
      },
      CO,
    );
    expect(attachments.map((a) => a.filename)).toEqual([
      `${CO}-Team-Getting-Started.pdf`,
      `${CO}-Administrator-Guide.pdf`,
      CUSTOMER_SERVICE_MANUAL_FILENAME,
    ]);
    for (const a of attachments) {
      expect(a.contentType).toBe("application/pdf");
      expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("gives a non-admin staff role the guide plus the manual", async () => {
    const attachments = await buildInviteHelpAttachments(
      {
        kind: "staff",
        role: "csr",
      },
      CO,
    );
    expect(attachments.map((a) => a.filename)).toEqual([
      `${CO}-Team-Getting-Started.pdf`,
      CUSTOMER_SERVICE_MANUAL_FILENAME,
    ]);
  });

  it("does not attach the manual to patient or provider invites", async () => {
    for (const audience of [
      { kind: "patient" } as const,
      { kind: "provider" } as const,
    ]) {
      const attachments = await buildInviteHelpAttachments(audience, CO);
      expect(attachments.map((a) => a.filename)).not.toContain(
        CUSTOMER_SERVICE_MANUAL_FILENAME,
      );
    }
  });

  it("renders the provider portal guide for provider invites", async () => {
    const attachments = await buildInviteHelpAttachments(
      { kind: "provider" },
      CO,
    );
    expect(attachments.map((a) => a.filename)).toEqual([
      `${CO}-Provider-Portal-Guide.pdf`,
    ]);
    const a = attachments[0]!;
    expect(a.contentType).toBe("application/pdf");
    expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(a.content.length).toBeGreaterThan(500);
  });

  it("caches rendered bytes across calls (same buffer reused)", async () => {
    const first = await buildInviteHelpAttachments({ kind: "patient" }, CO);
    const second = await buildInviteHelpAttachments({ kind: "patient" }, CO);
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

// ---------------------------------------------------------------------------
// Tenant branding
// ---------------------------------------------------------------------------
// These PDFs attach to patient-portal, provider-esign and staff invites. The
// copy, titles and FILENAMES were hardcoded to the seed tenant, so every other
// tenant's patients and providers received a guide branded "PennPaps" — while
// the surrounding email body was already tenant-correct. The docs are now
// factories over the tenant's own name, and the render cache is keyed on it.

describe("help documents carry the inviting tenant's name", () => {
  const OTHER = "Cascade Sleep Services";

  it("brands filenames and titles, with no seed tenant anywhere", () => {
    for (const doc of [
      ...patientHelpDocs(CO),
      ...providerHelpDocs(CO),
      ...staffHelpDocs("admin", CO),
    ]) {
      const blob = JSON.stringify(doc);
      expect(blob).not.toMatch(/PennPaps/);
      expect(doc.filename).toContain(CO);
      expect(blob).toContain(CO);
    }
  });

  it("does not let one tenant's render poison another's from cache", async () => {
    // The cache key gained the company name for exactly this reason: it is
    // keyed per document, so without it the first tenant to request a guide
    // would serve its bytes to everyone else.
    const first = await buildInviteHelpAttachments({ kind: "patient" }, CO);
    const second = await buildInviteHelpAttachments({ kind: "patient" }, OTHER);
    expect(first[0]!.filename).toBe(`${CO}-Patient-Portal-Guide.pdf`);
    expect(second[0]!.filename).toBe(`${OTHER}-Patient-Portal-Guide.pdf`);
    expect(second[0]!.content.equals(first[0]!.content)).toBe(false);
  });
});
