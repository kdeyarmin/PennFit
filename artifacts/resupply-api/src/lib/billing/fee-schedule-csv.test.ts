import { describe, expect, it } from "vitest";

import { parseFeeScheduleCsv } from "./fee-schedule-csv";

const PAYER = "11111111-1111-4111-8111-111111111111";

describe("parseFeeScheduleCsv", () => {
  it("parses a clean CSV", () => {
    const csv = [
      "hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes",
      "E0601,RR,12235,2026-01-01,,cms_published,Medicare DME 2026",
      "A7032,NU,2899,2026-01-01,2026-12-31,payer_published,",
    ].join("\n");
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: PAYER,
      csvBody: csv,
    });
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.hcpcs_code).toBe("E0601");
    expect(rows[0]!.modifier).toBe("RR");
    expect(rows[0]!.allowed_cents).toBe(12235);
    expect(rows[0]!.source).toBe("cms_published");
    expect(rows[1]!.effective_through).toBe("2026-12-31");
  });

  it("flags missing required header columns", () => {
    const csv = "hcpcs_code,allowed_cents\nE0601,1000";
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: PAYER,
      csvBody: csv,
    });
    expect(rows).toEqual([]);
    expect(errors[0]!.reason).toContain("missing required column");
  });

  it("skips bad rows without failing the whole import", () => {
    const csv = [
      "hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes",
      "E0601,RR,12235,2026-01-01,,cms_published,Good",
      "not_hcpcs,RR,12235,2026-01-01,,cms_published,Bad HCPCS",
      "A7032,RR,not_a_number,2026-01-01,,cms_published,Bad cents",
      "A7032,RR,1000,not_iso,,cms_published,Bad date",
      "A7032,RR,1000,2026-01-01,2025-12-31,cms_published,End before start",
      "A7032,bogus,1000,2026-01-01,,cms_published,Bad modifier",
      "A7032,RR,1000,2026-01-01,,unknown_src,Bad source",
    ].join("\n");
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: PAYER,
      csvBody: csv,
    });
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(6);
  });

  it("handles quoted notes with commas inside", () => {
    const csv = [
      "hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes",
      'E0601,RR,12235,2026-01-01,,cms_published,"Medicare, 2026 rate per CMS"',
    ].join("\n");
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: PAYER,
      csvBody: csv,
    });
    expect(errors).toEqual([]);
    expect(rows[0]!.notes).toBe("Medicare, 2026 rate per CMS");
  });

  it("respects maxRows + warns when truncated", () => {
    const lines = [
      "hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes",
    ];
    for (let i = 0; i < 12; i++) {
      lines.push("E0601,RR,12235,2026-01-01,,cms_published,row");
    }
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: PAYER,
      csvBody: lines.join("\n"),
      maxRows: 10,
    });
    expect(rows).toHaveLength(10);
    expect(errors.some((e) => e.reason.includes("truncated"))).toBe(true);
  });

  it("returns empty rows with no errors on an all-blank body", () => {
    const csv =
      "hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes\n\n\n";
    const { rows, errors } = parseFeeScheduleCsv({
      payerProfileId: PAYER,
      csvBody: csv,
    });
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });
});
