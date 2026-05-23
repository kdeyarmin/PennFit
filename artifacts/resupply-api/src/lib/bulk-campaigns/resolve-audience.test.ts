// Pure-function tests for the bulk-campaign audience resolver.

import { describe, it, expect } from "vitest";

import { resolveAudience } from "./resolve-audience";

describe("resolveAudience — shop customers", () => {
  const SHOP = [
    {
      id: "s-1",
      emailLower: "alice@example.test",
      communicationPreferences: { emailMarketing: true },
    },
    {
      id: "s-2",
      emailLower: "bob@example.test",
      communicationPreferences: { emailMarketing: false },
    },
    {
      id: "s-3",
      emailLower: null,
      communicationPreferences: null,
    },
  ];

  it("marketing category suppresses opted-out customers", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "marketing",
      shopCustomers: SHOP,
    });
    const bob = r.recipients.find((x) => x.recipientId === "s-2")!;
    expect(bob.status).toBe("suppressed");
    expect(bob.suppressionReason).toBe("opted_out_marketing");
  });

  it("compliance category bypasses opt-out", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "compliance",
      shopCustomers: SHOP,
    });
    const bob = r.recipients.find((x) => x.recipientId === "s-2")!;
    expect(bob.status).toBe("pending");
    expect(bob.suppressionReason).toBeNull();
  });

  it("suppresses customers with no email regardless of category", () => {
    for (const cat of ["marketing", "service", "compliance"] as const) {
      const r = resolveAudience({
        audienceKind: "all_active_shop_customers",
        audiencePayer: null,
        category: cat,
        shopCustomers: SHOP,
      });
      const noEmail = r.recipients.find((x) => x.recipientId === "s-3")!;
      expect(noEmail.status).toBe("suppressed");
      expect(noEmail.suppressionReason).toBe("no_email");
    }
  });

  it("service category respects emailResupplyReminders=false", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "service",
      shopCustomers: [
        {
          id: "s-9",
          emailLower: "x@example.test",
          communicationPreferences: { emailResupplyReminders: false },
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("suppressed");
    expect(r.recipients[0]!.suppressionReason).toBe("opted_out_service");
  });

  it("treats null communicationPreferences as default opted-in", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "marketing",
      shopCustomers: [
        {
          id: "s-null",
          emailLower: "n@example.test",
          communicationPreferences: null,
        },
      ],
    });
    // Default is opt-in for service; for marketing the absence of
    // an explicit emailMarketing=true (or even an explicit object)
    // SHOULD send unless the customer flipped it off. The resolver
    // only suppresses on explicit `=== false`, which matches the
    // "send unless they said no" semantics the rest of the
    // codebase already uses.
    expect(r.recipients[0]!.status).toBe("pending");
  });
});

describe("resolveAudience — patients", () => {
  const PATIENTS = [
    {
      id: "p-1",
      email: "active@example.test",
      status: "active",
      insurancePayer: "Medicare",
    },
    {
      id: "p-2",
      email: "paused@example.test",
      status: "paused",
      insurancePayer: "Medicare",
    },
    {
      id: "p-3",
      email: null,
      status: "active",
      insurancePayer: "Aetna",
    },
  ];

  it("suppresses non-active patients regardless of email/payer", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "service",
      patients: PATIENTS,
    });
    const paused = r.recipients.find((x) => x.recipientId === "p-2")!;
    expect(paused.status).toBe("suppressed");
    expect(paused.suppressionReason).toBe("patient_not_active");
  });

  it("suppresses active patients with no email", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "service",
      patients: PATIENTS,
    });
    const noEmail = r.recipients.find((x) => x.recipientId === "p-3")!;
    expect(noEmail.status).toBe("suppressed");
    expect(noEmail.suppressionReason).toBe("no_email");
  });

  it("by_patient_payer drops patients outside the payer filter", () => {
    const r = resolveAudience({
      audienceKind: "by_patient_payer",
      audiencePayer: "Aetna",
      category: "service",
      patients: PATIENTS,
    });
    // p-1 is Medicare → dropped (not even listed as suppressed —
    // they're not in the audience at all).
    // p-2 is Medicare → dropped.
    // p-3 is Aetna but no email → suppressed.
    expect(r.recipients.map((x) => x.recipientId)).toEqual(["p-3"]);
    expect(r.recipients[0]!.suppressionReason).toBe("no_email");
  });

  it("payer filter is case + whitespace tolerant", () => {
    const r = resolveAudience({
      audienceKind: "by_patient_payer",
      audiencePayer: "  medicare  ",
      category: "service",
      patients: [
        {
          id: "p-1",
          email: "x@example.test",
          status: "active",
          insurancePayer: "Medicare",
        },
      ],
    });
    expect(r.recipients).toHaveLength(1);
    expect(r.recipients[0]!.status).toBe("pending");
  });
});

describe("resolveAudience — totals + dedupe", () => {
  it("dedupes by (kind, id) — second occurrence ignored", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "compliance",
      shopCustomers: [
        {
          id: "s-1",
          emailLower: "x@example.test",
          communicationPreferences: null,
        },
        {
          id: "s-1",
          emailLower: "x@example.test",
          communicationPreferences: null,
        },
      ],
    });
    expect(r.recipients).toHaveLength(1);
  });

  it("a shop_customer and a patient with the same UUID are kept separately", () => {
    const SHARED_UUID = "00000000-0000-4000-8000-0000000000aa";
    const r = resolveAudience({
      audienceKind: "manual_list",
      audiencePayer: null,
      category: "service",
      shopCustomers: [
        {
          id: SHARED_UUID,
          emailLower: "x@example.test",
          communicationPreferences: null,
        },
      ],
      patients: [
        {
          id: SHARED_UUID,
          email: "y@example.test",
          status: "active",
          insurancePayer: null,
        },
      ],
    });
    expect(r.recipients).toHaveLength(2);
    expect(r.recipients.map((x) => x.recipientKind).sort()).toEqual([
      "patient",
      "shop_customer",
    ]);
  });

  it("totals match the per-row dispositions", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "marketing",
      shopCustomers: [
        {
          id: "a",
          emailLower: "a@example.test",
          communicationPreferences: { emailMarketing: true },
        },
        {
          id: "b",
          emailLower: "b@example.test",
          communicationPreferences: { emailMarketing: false },
        },
        {
          id: "c",
          emailLower: null,
          communicationPreferences: null,
        },
      ],
    });
    expect(r.totals.total).toBe(3);
    expect(r.totals.pending).toBe(1);
    expect(r.totals.suppressed).toBe(2);
  });

  it("empty audience produces zeroed totals", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "marketing",
      shopCustomers: [],
    });
    expect(r.totals).toEqual({ total: 0, pending: 0, suppressed: 0 });
    expect(r.recipients).toEqual([]);
  });
});
