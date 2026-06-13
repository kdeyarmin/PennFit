import { describe, expect, it } from "vitest";

import {
  patientPacketReceiptDescription,
  patientPacketReceiptLabel,
} from "./patient-packet-status";

describe("patient packet receipt helpers", () => {
  it("distinguishes waiting, opened, received, and filed states", () => {
    expect(patientPacketReceiptLabel({ status: "sent" })).toBe(
      "Awaiting signature",
    );
    expect(patientPacketReceiptLabel({ status: "viewed" })).toBe(
      "Opened, awaiting signature",
    );
    expect(patientPacketReceiptLabel({ status: "completed" })).toBe(
      "Signature received",
    );
    expect(
      patientPacketReceiptLabel({
        status: "completed",
        chart_document_id: "doc-1",
      }),
    ).toBe("Signature received and filed");
  });

  it("explains when a signed packet still needs manual chart filing", () => {
    expect(
      patientPacketReceiptDescription({
        status: "completed",
        patient_id: "patient-1",
      }),
    ).toContain("Download the signed PDF");
  });
});
