import { beforeEach, describe, expect, it } from "vitest";

import type { AdminRole } from "@workspace/resupply-db";

import {
  CUSTOMER_SERVICE_MANUAL_FILENAME,
  patientHelpDocs,
  providerHelpDocs,
  buildInviteHelpAttachments,
  loadCustomerServiceManual,
  staffHelpDocs,
  staffRoleProfile,
  __clearHelpDocCache,
  __clearManualCache,
} from "./index";

/** A tenant that is deliberately NOT the seed tenant. */
const CO = "Northwind Respiratory";

beforeEach(() => {
  __clearHelpDocCache();
  __clearManualCache();
});

const ALL_ROLES: AdminRole[] = [
  "admin",
  "supervisor",
  "compliance_officer",
  "csr",
  "fitter",
  "fulfillment",
  "agent",
  "biller",
  "rt",
];

describe("staffRoleProfile", () => {
  it("maps every granular role to a job family with real copy", () => {
    for (const role of ALL_ROLES) {
      const p = staffRoleProfile(role);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.summary.length).toBeGreaterThan(0);
      expect(p.highlights.length).toBeGreaterThan(0);
      expect(p.areas.length).toBeGreaterThan(0);
      expect(p.firstTasks.length).toBeGreaterThan(0);
    }
  });

  it("collapses the legacy role names onto the family they belong to", () => {
    // agent / fitter / fulfillment are persisted on old rows but are not
    // offered by the invite UI; they are customer-service jobs.
    for (const role of ["agent", "fitter", "fulfillment"] as const) {
      expect(staffRoleProfile(role).family).toBe("csr");
    }
    // supervisor / compliance_officer both render as "Admin" in the
    // console, and neither is the Owner (team + system settings are
    // requireAdminOnly, i.e. role === "admin").
    for (const role of ["supervisor", "compliance_officer"] as const) {
      expect(staffRoleProfile(role).family).toBe("admin");
    }
    expect(staffRoleProfile("admin").family).toBe("owner");
    expect(staffRoleProfile("admin").title).toBe("Owner");
  });

  it("uses the same job titles the console and the User Manual use", () => {
    // The invite email used to say "Super admin" while the team page and
    // the manual both said "Owner" — a new hire was told a title nothing
    // else in the product uses.
    expect(staffRoleProfile("admin").title).toBe("Owner");
    expect(staffRoleProfile("supervisor").title).toBe("Admin");
    expect(staffRoleProfile("csr").title).toBe("Customer service rep");
    expect(staffRoleProfile("biller").title).toBe("Biller");
    expect(staffRoleProfile("rt").title).toBe("Respiratory therapist");
  });
});

describe("staffHelpDocs", () => {
  it("gives every staff role the activation guide plus their own handbook", () => {
    for (const role of ALL_ROLES) {
      const profile = staffRoleProfile(role);
      const docs = staffHelpDocs(role, CO);
      expect(docs.map((d) => d.key)).toEqual([
        "staff-getting-started",
        `staff-handbook-${profile.family}`,
      ]);
      // The handbook is named for the job, so it is obvious in a mail
      // client which attachment is "yours".
      expect(docs[1]!.title).toContain(profile.title);
    }
  });

  it("puts the role's own duties in the handbook, not a generic blurb", () => {
    const biller = staffHelpDocs("biller", CO)[1]!;
    const blob = JSON.stringify(biller);
    expect(blob).toContain("revenue cycle");
    expect(blob).toContain("A/R Aging");
    // …and does NOT describe somebody else's job.
    expect(blob).not.toContain("Clinical Encounters");

    const rt = JSON.stringify(staffHelpDocs("rt", CO)[1]!);
    expect(rt).toContain("Clinical Encounters");
    expect(rt).not.toContain("A/R Aging");
  });

  // Onboarding must never send a new hire at a screen their role 403s on:
  // a written promise is worse than a dead end they'd have discovered.
  // Each assertion below tracks a permission the role does NOT hold in
  // `EFFECTIVE_ROLE_PERMISSIONS` (lib/resupply-auth/src/rbac.ts).
  it("never promises work the role has no permission for", () => {
    // customer_service_rep lacks bulk_campaigns.send, and every
    // bulk-campaign route requires it — including draft creation.
    const csr = JSON.stringify(staffHelpDocs("csr", CO));
    expect(csr).not.toMatch(/bulk campaign/i);

    // A biller may READ payer profiles / fee schedules (reports.read) but
    // the writes are requireAdminOnly, i.e. the Owner.
    const bill = JSON.stringify(staffHelpDocs("biller", CO));
    expect(bill).not.toMatch(/keep payer profiles[^"]*current/i);

    // clinician holds no reports.read / returns.read / cases.read, so the
    // population dashboards, recalls and asset recovery don't load. The
    // handbook must say so rather than list them as the RT's work.
    const rt = staffHelpDocs("rt", CO)[1]!;
    const caveat = rt.sections.find((sec) =>
      sec.heading?.startsWith("What your role does not cover"),
    );
    expect(caveat).toBeDefined();
    const rtDuties = JSON.stringify({
      areas: staffRoleProfile("rt").areas,
      highlights: staffRoleProfile("rt").highlights,
      firstTasks: staffRoleProfile("rt").firstTasks,
    });
    for (const screen of ["Therapy Fleet", "Setup Adherence", "Recalls"]) {
      expect(JSON.stringify(caveat)).toContain(screen);
      // …and named ONLY there, never as a duty of the role.
      expect(rtDuties).not.toContain(screen);
    }
  });

  it("keys each family's handbook separately so the byte cache can't cross roles", () => {
    // The rendered-bytes cache is keyed on doc.key + version + tenant.
    // Two roles sharing a key would serve one role's handbook to the
    // other; two roles in the SAME family legitimately share one.
    const keys = ALL_ROLES.map((r) => staffHelpDocs(r, CO)[1]!.key);
    const families = ALL_ROLES.map((r) => staffRoleProfile(r).family);
    for (let i = 0; i < ALL_ROLES.length; i += 1) {
      for (let j = 0; j < ALL_ROLES.length; j += 1) {
        expect(keys[i] === keys[j]).toBe(families[i] === families[j]);
      }
    }
  });

  it("keeps the owner's team-management and roles guidance", () => {
    // This prose used to live in a separate admin-only guide; it must
    // not have been lost when the guide became a role handbook.
    const owner = JSON.stringify(staffHelpDocs("admin", CO)[1]!);
    expect(owner).toContain("Managing your team");
    expect(owner).toContain("Revoke a member");
    expect(owner).toContain("least access their job needs");
    // An Admin is not the Owner and cannot manage the team.
    expect(JSON.stringify(staffHelpDocs("supervisor", CO)[1]!)).not.toContain(
      "Managing your team",
    );
  });

  it("orders the first-week checklist rather than bulleting it", () => {
    // The order is the instruction — "turn on MFA" before "download the
    // manual" — so these render numbered, not as an unordered blob.
    for (const role of ALL_ROLES) {
      const handbook = staffHelpDocs(role, CO)[1]!;
      const firstWeek = handbook.sections.find(
        (sec) => sec.heading === "Your first week",
      );
      expect(firstWeek?.steps?.length).toBeGreaterThan(0);
      expect(firstWeek?.bullets).toBeUndefined();
    }
    const activation = staffHelpDocs("csr", CO)[0]!.sections.find(
      (sec) => sec.heading === "Activating your account",
    );
    expect(activation?.steps?.length).toBeGreaterThan(0);
  });

  // POST /admin/team/:id/resend 409s on any non-pending row, so an ACTIVE
  // member whose reset email went missing cannot be helped that way.
  it("does not tell an already-active user to ask for an invite resend", () => {
    const guide = staffHelpDocs("csr", CO)[0]!;
    const signingIn = guide.sections.find((sec) =>
      sec.heading?.startsWith("Signing in from then on"),
    );
    expect(JSON.stringify(signingIn)).not.toMatch(/resend your invite/i);
    // The pending-invite case genuinely can be resent, and still says so.
    const activating = guide.sections.find(
      (sec) => sec.heading === "Activating your account",
    );
    expect(JSON.stringify(activating)).toMatch(/resend your invite/i);
  });

  it("gives the role-neutral guide no role-specific copy", () => {
    // It is cached per tenant, NOT per role — role copy here would be
    // rendered once and mailed to every other role.
    const a = JSON.stringify(staffHelpDocs("biller", CO)[0]!);
    const b = JSON.stringify(staffHelpDocs("rt", CO)[0]!);
    expect(a).toBe(b);
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

  it("renders the owner's guide, handbook, and the customer service manual", async () => {
    const attachments = await buildInviteHelpAttachments(
      {
        kind: "staff",
        role: "admin",
      },
      CO,
    );
    expect(attachments.map((a) => a.filename)).toEqual([
      `${CO}-Team-Getting-Started.pdf`,
      `${CO}-Owner-Handbook.pdf`,
      CUSTOMER_SERVICE_MANUAL_FILENAME,
    ]);
    for (const a of attachments) {
      expect(a.contentType).toBe("application/pdf");
      expect(a.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });

  it("gives a CSR the guide, the CSR handbook, and the service-desk manual", async () => {
    const attachments = await buildInviteHelpAttachments(
      {
        kind: "staff",
        role: "csr",
      },
      CO,
    );
    expect(attachments.map((a) => a.filename)).toEqual([
      `${CO}-Team-Getting-Started.pdf`,
      `${CO}-Customer-Service-Rep-Handbook.pdf`,
      CUSTOMER_SERVICE_MANUAL_FILENAME,
    ]);
  });

  // The point of the change: the Customer Service Manual used to go to
  // EVERY staff invite, so a biller's welcome email arrived with a
  // customer-service manual and nothing about the revenue cycle.
  it("sends a biller and an RT their own handbook, not the service-desk manual", async () => {
    for (const [role, handbook] of [
      ["biller", `${CO}-Biller-Handbook.pdf`],
      ["rt", `${CO}-Respiratory-Therapist-Handbook.pdf`],
    ] as const) {
      const attachments = await buildInviteHelpAttachments(
        { kind: "staff", role },
        CO,
      );
      expect(attachments.map((a) => a.filename)).toEqual([
        `${CO}-Team-Getting-Started.pdf`,
        handbook,
      ]);
    }
  });

  it("explains each attachment, so a filename isn't the only clue", async () => {
    const attachments = await buildInviteHelpAttachments(
      { kind: "staff", role: "biller" },
      CO,
    );
    for (const a of attachments) {
      expect(a.description.length).toBeGreaterThan(0);
    }
    expect(attachments[0]!.description).toMatch(/^Read this first/);
    expect(attachments[1]!.description).toContain("what the role owns");
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
// tenant's patients and providers received a guide branded "Penn Home Medical Supply" — while
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
      expect(blob).not.toMatch(/Penn Home Medical Supply/);
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
