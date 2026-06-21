import { describe, it, expect } from "vitest";

import { pickFeeScheduleRowByModifiers } from "./fee-schedule-match";

type Row = { id: string; modifier: string | null };

describe("pickFeeScheduleRowByModifiers", () => {
  it("returns null when there are no candidates", () => {
    expect(pickFeeScheduleRowByModifiers<Row>([], ["KX"])).toBeNull();
  });

  it("matches a single-modifier row", () => {
    const rows: Row[] = [
      { id: "wild", modifier: null },
      { id: "kx", modifier: "KX" },
    ];
    expect(pickFeeScheduleRowByModifiers(rows, ["RR", "KX"])?.id).toBe("kx");
  });

  it("reaches a comma-joined multi-modifier row (subset match)", () => {
    const rows: Row[] = [
      { id: "wild", modifier: null },
      { id: "kx", modifier: "KX" },
      { id: "kxkh", modifier: "KX,KH" },
    ];
    // Line carries RR,KH,KX → the most specific applicable row (KX,KH) wins.
    expect(pickFeeScheduleRowByModifiers(rows, ["RR", "KH", "KX"])?.id).toBe(
      "kxkh",
    );
  });

  it("is order-insensitive on the row's modifier set", () => {
    const rows: Row[] = [{ id: "khkx", modifier: "KH,KX" }];
    expect(pickFeeScheduleRowByModifiers(rows, ["KX", "KH"])?.id).toBe("khkx");
  });

  it("requires the row's set to be a SUBSET of the line (not just overlap)", () => {
    const rows: Row[] = [
      { id: "wild", modifier: null },
      { id: "kxkh", modifier: "KX,KH" },
    ];
    // Line has only KX → the KX,KH row does not apply → wildcard.
    expect(pickFeeScheduleRowByModifiers(rows, ["KX"])?.id).toBe("wild");
  });

  it("falls back to the wildcard, then the first row, when nothing applies", () => {
    expect(
      pickFeeScheduleRowByModifiers<Row>(
        [
          { id: "kx", modifier: "KX" },
          { id: "wild", modifier: null },
        ],
        ["RR"],
      )?.id,
    ).toBe("wild");
    expect(
      pickFeeScheduleRowByModifiers<Row>([{ id: "kx", modifier: "KX" }], ["RR"])
        ?.id,
    ).toBe("kx");
  });

  it("keeps the newest row at a given specificity (candidates ordered newest-first)", () => {
    const rows: Row[] = [
      { id: "kx_new", modifier: "KX" },
      { id: "kx_old", modifier: "KX" },
    ];
    expect(pickFeeScheduleRowByModifiers(rows, ["KX"])?.id).toBe("kx_new");
  });
});
