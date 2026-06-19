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

describe("resolveAudience — SMS channel", () => {
  it("snapshots the phone and suppresses patients with no phone", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "service",
      channel: "sms",
      patients: [
        {
          id: "p-1",
          email: "a@example.test",
          phone: "+12155551212",
          status: "active",
          insurancePayer: null,
        },
        {
          id: "p-2",
          email: "b@example.test",
          phone: null,
          status: "active",
          insurancePayer: null,
        },
      ],
    });
    const sent = r.recipients.find((x) => x.recipientId === "p-1")!;
    expect(sent.status).toBe("pending");
    expect(sent.recipientPhone).toBe("+12155551212");
    expect(sent.recipientEmail).toBeNull(); // SMS snapshot omits email
    const noPhone = r.recipients.find((x) => x.recipientId === "p-2")!;
    expect(noPhone.status).toBe("suppressed");
    expect(noPhone.suppressionReason).toBe("no_phone");
  });

  it("suppresses known non-mobile (landline/voip) and allows mobile/unknown", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "service",
      channel: "sms",
      patients: [
        {
          id: "mob",
          email: null,
          phone: "+12155550001",
          phoneLineType: "mobile",
          status: "active",
          insurancePayer: null,
        },
        {
          id: "land",
          email: null,
          phone: "+12155550002",
          phoneLineType: "landline",
          status: "active",
          insurancePayer: null,
        },
        {
          id: "voip",
          email: null,
          phone: "+12155550003",
          phoneLineType: "voip",
          status: "active",
          insurancePayer: null,
        },
        {
          id: "unk",
          email: null,
          phone: "+12155550004",
          phoneLineType: null,
          status: "active",
          insurancePayer: null,
        },
      ],
    });
    const byId = (id: string) =>
      r.recipients.find((x) => x.recipientId === id)!;
    expect(byId("mob").status).toBe("pending");
    expect(byId("unk").status).toBe("pending"); // allow-unknown
    expect(byId("land").status).toBe("suppressed");
    expect(byId("land").suppressionReason).toBe("phone_not_mobile");
    expect(byId("voip").status).toBe("suppressed");
    expect(byId("voip").suppressionReason).toBe("phone_not_mobile");
  });

  it("ignores line type entirely for the email channel", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "service",
      channel: "email",
      patients: [
        {
          id: "land",
          email: "x@example.test",
          phone: "+12155550002",
          phoneLineType: "landline",
          status: "active",
          insurancePayer: null,
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("pending");
  });

  it("requires explicit SMS opt-in for shop customers (opt-in, not opt-out)", () => {
    const r = resolveAudience({
      audienceKind: "all_active_shop_customers",
      audiencePayer: null,
      category: "marketing",
      channel: "sms",
      shopCustomers: [
        {
          id: "s-false",
          emailLower: "x@example.test",
          phoneE164: "+12155550001",
          communicationPreferences: { smsMarketing: false },
        },
        {
          id: "s-null",
          emailLower: "z@example.test",
          phoneE164: "+12155550003",
          // Never set prefs — default is smsMarketing:false, so NOT opted in.
          communicationPreferences: null,
        },
        {
          id: "s-true",
          emailLower: "y@example.test",
          phoneE164: "+12155550002",
          communicationPreferences: { smsMarketing: true },
        },
      ],
    });
    const byId = (id: string) =>
      r.recipients.find((x) => x.recipientId === id)!;
    expect(byId("s-false").status).toBe("suppressed");
    expect(byId("s-false").suppressionReason).toBe("sms_not_opted_in");
    // Missing prefs must NOT be texted (opt-in).
    expect(byId("s-null").status).toBe("suppressed");
    expect(byId("s-null").suppressionReason).toBe("sms_not_opted_in");
    // Only the explicit opt-in is sent.
    expect(byId("s-true").status).toBe("pending");
    expect(byId("s-true").recipientPhone).toBe("+12155550002");
  });

  it("compliance bypasses shop SMS opt-out but never a paused patient", () => {
    const r = resolveAudience({
      audienceKind: "manual_list",
      audiencePayer: null,
      category: "compliance",
      channel: "sms",
      shopCustomers: [
        {
          id: "s-1",
          emailLower: null,
          phoneE164: "+12155550001",
          communicationPreferences: { smsMarketing: false },
        },
      ],
      patients: [
        {
          id: "p-paused",
          email: null,
          phone: "+12155550003",
          status: "paused",
          insurancePayer: null,
        },
      ],
    });
    const shop = r.recipients.find((x) => x.recipientId === "s-1")!;
    expect(shop.status).toBe("pending"); // compliance overrides opt-out pref
    const paused = r.recipients.find((x) => x.recipientId === "p-paused")!;
    expect(paused.status).toBe("suppressed");
    expect(paused.suppressionReason).toBe("patient_not_active");
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

// ─────────────────────────────────────────────────────────────────────────────
// Patient SMS-marketing consent gate (migration 0401)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAudience — patient SMS marketing consent (TCPA opt-in)", () => {
  it("suppresses a patient with smsMarketingConsent=false for marketing SMS", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "marketing",
      channel: "sms",
      patients: [
        {
          id: "p-no-consent",
          email: "a@example.test",
          phone: "+12155550001",
          status: "active",
          insurancePayer: null,
          smsMarketingConsent: false,
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("suppressed");
    expect(r.recipients[0]!.suppressionReason).toBe("sms_not_opted_in");
  });

  it("suppresses a patient with smsMarketingConsent=null/undefined for marketing SMS", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "marketing",
      channel: "sms",
      patients: [
        {
          id: "p-null-consent",
          email: "b@example.test",
          phone: "+12155550002",
          status: "active",
          insurancePayer: null,
          // smsMarketingConsent omitted → treated as no consent (TCPA opt-in)
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("suppressed");
    expect(r.recipients[0]!.suppressionReason).toBe("sms_not_opted_in");
  });

  it("includes a patient with smsMarketingConsent=true for marketing SMS", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "marketing",
      channel: "sms",
      patients: [
        {
          id: "p-consented",
          email: "c@example.test",
          phone: "+12155550003",
          status: "active",
          insurancePayer: null,
          smsMarketingConsent: true,
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("pending");
    expect(r.recipients[0]!.recipientPhone).toBe("+12155550003");
  });

  it("service SMS does not require smsMarketingConsent (not marketing)", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "service",
      channel: "sms",
      patients: [
        {
          id: "p-no-consent",
          email: "d@example.test",
          phone: "+12155550004",
          status: "active",
          insurancePayer: null,
          smsMarketingConsent: false,
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("pending");
  });

  it("compliance SMS does not require smsMarketingConsent", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "compliance",
      channel: "sms",
      patients: [
        {
          id: "p-no-consent",
          email: "e@example.test",
          phone: "+12155550005",
          status: "active",
          insurancePayer: null,
          smsMarketingConsent: false,
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("pending");
  });

  it("marketing email does not require smsMarketingConsent", () => {
    const r = resolveAudience({
      audienceKind: "all_active_patients",
      audiencePayer: null,
      category: "marketing",
      channel: "email",
      patients: [
        {
          id: "p-no-consent",
          email: "f@example.test",
          phone: "+12155550006",
          status: "active",
          insurancePayer: null,
          smsMarketingConsent: false,
        },
      ],
    });
    expect(r.recipients[0]!.status).toBe("pending");
  });
});
