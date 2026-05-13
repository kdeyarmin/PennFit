// Pin the MedWatch summary helper. Surveyors care that the field
// shape stays consistent — a future refactor that drops the
// patientInitials field (or stops escaping HTML) would land us
// in awkward conversations.

import { describe, it, expect } from "vitest";

import { buildMedWatchSummary } from "./build-summary";

const PATIENT = {
  id: "p_1",
  legalFirstName: "Jane",
  legalLastName: "Smith",
  dateOfBirth: "1965-03-15",
  sex: "female",
};

const GRIEVANCE = {
  id: "g_abcdef123",
  summary: "Sudden device shutdown mid-session",
  description: "Patient woke up at 2am with the machine off.",
  severity: "high" as const,
  receivedAt: "2026-04-22",
  fdaReportReference: null,
  kind: "adverse_event" as const,
};

const ASSET = {
  manufacturer: "Philips",
  model: "DreamStation",
  serialNumber: "S2024-0099",
  dispensedAt: "2024-01-15",
};

describe("buildMedWatchSummary", () => {
  it("computes initials, age, and basic field shape", () => {
    const r = buildMedWatchSummary(
      {
        grievance: GRIEVANCE,
        patient: PATIENT,
        asset: ASSET,
        practiceName: "Test DME",
      },
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(r.fields.patientInitials).toBe("JS");
    expect(r.fields.patientAge).toBe("61"); // 2026-05 - 1965-03 = 61
    expect(r.fields.patientSex).toBe("F");
    expect(r.fields.eventDate).toBe("2026-04-22");
    expect(r.fields.productName).toBe("Philips DreamStation");
    expect(r.fields.lotSerial).toBe("S2024-0099");
    expect(r.fields.reportReference).toBe("PennFit-g_abcdef");
  });

  it("falls back to '—' fields when no asset is supplied", () => {
    const r = buildMedWatchSummary({
      grievance: GRIEVANCE,
      patient: PATIENT,
      asset: null,
      practiceName: "Test DME",
    });
    expect(r.fields.productName).toBe("—");
    expect(r.fields.lotSerial).toBe("—");
  });

  it("respects an existing fda_report_reference", () => {
    const r = buildMedWatchSummary({
      grievance: { ...GRIEVANCE, fdaReportReference: "MW-2026-0001" },
      patient: PATIENT,
      asset: ASSET,
      practiceName: "Test DME",
    });
    expect(r.fields.reportReference).toBe("MW-2026-0001");
  });

  it("escapes HTML in the rendered preview", () => {
    const r = buildMedWatchSummary({
      grievance: {
        ...GRIEVANCE,
        summary: "<script>alert(1)</script>",
        description: null,
      },
      patient: PATIENT,
      asset: ASSET,
      practiceName: "Test DME",
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("handles a pre-birthday-this-year DOB (correct year count)", () => {
    const r = buildMedWatchSummary(
      {
        grievance: GRIEVANCE,
        patient: { ...PATIENT, dateOfBirth: "1965-12-31" },
        asset: ASSET,
        practiceName: "Test DME",
      },
      new Date("2026-05-01T00:00:00Z"),
    );
    // 2026-05-01 < 1965-12-31's anniversary in 2026, so age = 60.
    expect(r.fields.patientAge).toBe("60");
  });
});
