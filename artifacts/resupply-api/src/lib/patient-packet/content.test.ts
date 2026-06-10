import { describe, expect, it } from "vitest";

import {
  defaultTemplateSections,
  effectiveTemplateContent,
  findUnknownTokens,
  listMergeTokens,
  parseStoredSections,
  renderPacketDocumentSections,
  substituteTokens,
  type TemplateOverrideRow,
} from "./content";
import { FALLBACK_COMPANY, getPacketTemplate } from "./templates";

const COMPANY = {
  legalName: "Acme Sleep Supply",
  phone: "(555) 010-0000",
  email: "care@acme.example",
  addressLine1: "1 Main St",
  cityStateZip: "Philadelphia, PA 19103",
  npi: "1234567890",
};

describe("merge tokens", () => {
  it("substitutes company and patient tokens", () => {
    const out = substituteTokens(
      "Welcome to {{company_name}}, {{patient_first_name}} — call {{company_phone}}.",
      { company: COMPANY, recipientName: "Ann Lee" },
    );
    expect(out).toBe(
      "Welcome to Acme Sleep Supply, Ann — call (555) 010-0000.",
    );
  });

  it("leaves unknown tokens verbatim when rendering", () => {
    const out = substituteTokens("Hello {{not_a_token}}.", {
      company: COMPANY,
    });
    expect(out).toBe("Hello {{not_a_token}}.");
  });

  it("findUnknownTokens flags only unknown names", () => {
    const unknown = findUnknownTokens([
      {
        heading: "{{company_name}}",
        paragraphs: ["{{patient_name}} and {{tpyo_token}}"],
        bullets: ["{{today}}"],
      },
    ]);
    expect(unknown).toEqual(["tpyo_token"]);
  });

  it("every cataloged token resolves to a string", () => {
    for (const { token } of listMergeTokens()) {
      const out = substituteTokens(`{{${token}}}`, {
        company: COMPANY,
        recipientName: "Ann Lee",
        recipientEmail: "ann@example.com",
        recipientPhone: "+12155550000",
        now: new Date("2026-06-10T12:00:00Z"),
      });
      expect(out).not.toContain("{{");
    }
  });
});

describe("defaultTemplateSections", () => {
  it("converts code interpolations to merge tokens", () => {
    const sections = defaultTemplateSections("assignment_of_benefits");
    const text = JSON.stringify(sections);
    expect(text).toContain("{{company_name}}");
    expect(text).not.toContain(FALLBACK_COMPANY.legalName);
  });

  it("matches the code template when rendered with the same company", () => {
    const viaTokens = renderPacketDocumentSections({
      documentKey: "notice_of_privacy_practices",
      storedSections: defaultTemplateSections("notice_of_privacy_practices"),
      company: COMPANY,
    });
    const direct = getPacketTemplate("notice_of_privacy_practices")!.build(
      COMPANY,
    );
    expect(viaTokens).toEqual(direct);
  });
});

describe("effectiveTemplateContent", () => {
  const override: TemplateOverrideRow = {
    document_key: "assignment_of_benefits",
    title: "Custom AOB",
    sections: [{ paragraphs: ["Custom wording for {{company_name}}."] }],
    revision: 3,
    updated_by_email: "admin@example.com",
    updated_at: "2026-06-10T00:00:00Z",
  };

  it("uses the override when present and parseable", () => {
    const map = new Map([[override.document_key, override]]);
    const eff = effectiveTemplateContent("assignment_of_benefits", map)!;
    expect(eff.customized).toBe(true);
    expect(eff.title).toBe("Custom AOB");
    expect(eff.version).toMatch(/\+custom\.r3$/u);
  });

  it("falls back to the code default when the override is malformed", () => {
    const map = new Map([
      [
        override.document_key,
        { ...override, sections: "not sections" as unknown },
      ],
    ]);
    const eff = effectiveTemplateContent("assignment_of_benefits", map)!;
    expect(eff.customized).toBe(false);
    expect(eff.title).toBe(getPacketTemplate("assignment_of_benefits")!.title);
  });

  it("returns null for an unknown key", () => {
    expect(effectiveTemplateContent("nope", new Map())).toBeNull();
  });
});

describe("renderPacketDocumentSections", () => {
  it("legacy rows (no snapshot) build from the code template", () => {
    const out = renderPacketDocumentSections({
      documentKey: "welcome_instructions",
      storedSections: null,
      company: COMPANY,
    });
    expect(out).toEqual(
      getPacketTemplate("welcome_instructions")!.build(COMPANY),
    );
  });

  it("splices the POD itemization after the first stored section", () => {
    const stored = [
      { paragraphs: ["Intro for {{patient_name}}."] },
      { heading: "I confirm that", bullets: ["Everything arrived."] },
    ];
    const out = renderPacketDocumentSections({
      documentKey: "proof_of_delivery",
      storedSections: stored,
      company: COMPANY,
      recipientName: "Ann Lee",
      deliveryDetails: {
        items: [{ description: "CPAP device", hcpcs: "E0601", quantity: 1 }],
        deliveryDate: "2026-06-01",
      },
    });
    expect(out[0]).toEqual({ paragraphs: ["Intro for Ann Lee."] });
    expect(out[1]!.heading).toBe("Equipment delivered");
    expect(out[1]!.bullets).toEqual(["1 × CPAP device (HCPCS E0601)"]);
    expect(out[2]!.heading).toBe("Delivery details");
    expect(out.at(-1)!.heading).toBe("I confirm that");
  });

  it("does not splice delivery sections into non-POD documents", () => {
    const stored = [{ paragraphs: ["Only paragraph."] }];
    const out = renderPacketDocumentSections({
      documentKey: "consent_to_care",
      storedSections: stored,
      company: COMPANY,
      deliveryDetails: { items: [{ description: "X" }] },
    });
    expect(out).toEqual(stored);
  });
});

describe("parseStoredSections", () => {
  it("accepts valid sections and rejects junk", () => {
    expect(parseStoredSections([{ paragraphs: ["ok"] }])).toEqual([
      { paragraphs: ["ok"] },
    ]);
    expect(parseStoredSections("nope")).toBeNull();
    expect(parseStoredSections([{}])).toBeNull();
    expect(parseStoredSections([])).toBeNull();
  });
});
