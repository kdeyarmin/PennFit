import { describe, expect, it } from "vitest";

import { assemblePacket } from "./assemble";
import {
  type AuditPacketBuildInput,
  buildAuditPacket,
} from "./build-audit-packet";
import { renderPdfPage } from "./sections";

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

async function onePagePdf(title: string): Promise<Buffer> {
  return renderPdfPage([{ t: "title", text: title }]);
}

const BASE: AuditPacketBuildInput = {
  scope: "device",
  selectedKeys: [],
  company: { legalName: "Penn Home Medical Supply", npi: "1234567890" },
  patient: { name: "Jane Doe", dateOfBirth: "1960-01-01" },
  generatedOn: new Date("2026-06-22T00:00:00Z"),
};

describe("assemblePacket", () => {
  it("merges PDFs and sums their page counts", async () => {
    const a = await onePagePdf("A");
    const b = await onePagePdf("B");
    const res = await assemblePacket([
      { kind: "pdf", label: "a", bytes: a },
      { kind: "pdf", label: "b", bytes: b },
    ]);
    expect(isPdf(res.pdf)).toBe(true);
    expect(res.pageCount).toBe(2);
    expect(res.skipped).toEqual([]);
  });

  it("skips an unsupported image type without failing", async () => {
    const res = await assemblePacket([
      { kind: "pdf", label: "a", bytes: await onePagePdf("A") },
      {
        kind: "image",
        label: "heic-card",
        bytes: Buffer.from([0, 1, 2, 3]),
        contentType: "image/heic",
      },
    ]);
    expect(res.pageCount).toBe(1);
    expect(res.skipped).toEqual([
      { label: "heic-card", reason: "unsupported_image" },
    ]);
  });
});

describe("buildAuditPacket", () => {
  it("renders a cover sheet first, generated summaries, and attached docs", async () => {
    const storedSleepStudy = await onePagePdf("Sleep Study Report");
    const res = await buildAuditPacket({
      ...BASE,
      selectedKeys: [
        "cover_sheet",
        "compliance_report",
        "sleep_study",
        "reeval_31_91",
      ],
      adherence: {
        windowStart: "2026-03-01",
        windowEnd: "2026-03-30",
        nightsUsed: 26,
        nightsTotal: 30,
        avgHoursPerNight: 6.4,
        meetsCms: true,
      },
      documentsByItem: {
        sleep_study: [
          {
            label: "PSG report",
            bytes: storedSleepStudy,
            contentType: "application/pdf",
          },
        ],
      },
    });

    expect(isPdf(res.pdf)).toBe(true);
    // cover + compliance + divider + sleep-study doc = 4 pages.
    expect(res.pageCount).toBe(4);

    const byKey = Object.fromEntries(res.items.map((i) => [i.key, i.status]));
    expect(byKey.cover_sheet).toBe("generated");
    expect(byKey.compliance_report).toBe("generated");
    expect(byKey.sleep_study).toBe("attached");
    // Selected but nothing on file — reported missing, not rendered as a gap.
    expect(byKey.reeval_31_91).toBe("missing");

    const sleep = res.items.find((i) => i.key === "sleep_study");
    expect(sleep?.documentCount).toBe(1);
  });

  it("renders a generated fallback for a hybrid item with no stored doc", async () => {
    const res = await buildAuditPacket({
      ...BASE,
      scope: "supplies",
      selectedKeys: ["refill_request"],
      // refill_request is hybrid; with no stored doc and no generated data it
      // is reported missing (no fabricated evidence).
    });
    const refill = res.items.find((i) => i.key === "refill_request");
    expect(refill?.status).toBe("missing");
  });

  it("reports unknown keys and ignores them", async () => {
    const res = await buildAuditPacket({
      ...BASE,
      selectedKeys: ["cover_sheet", "not_a_real_item"],
    });
    expect(res.unknownKeys).toEqual(["not_a_real_item"]);
  });
});
