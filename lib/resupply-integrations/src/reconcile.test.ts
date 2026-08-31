import { describe, expect, it } from "vitest";

import {
  reconcileIntegrationSource,
  type LocalPatientRow,
  type PortalPatientRow,
} from "./reconcile";

const SOURCE = "resmed_airview" as const;

function portal(over: Partial<PortalPatientRow> = {}): PortalPatientRow {
  return { partnerPatientId: "P-1", ...over };
}
function local(over: Partial<LocalPatientRow> = {}): LocalPatientRow {
  return { partnerPatientId: "P-1", ...over };
}

describe("reconcileIntegrationSource — presence", () => {
  it("reports a patient the portal has and we do not", () => {
    // The failure this whole thing exists to catch: a patient the
    // practice believes is monitored and who has never been linked.
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ partnerPatientId: "P-9" })],
      [],
    );
    expect(r.missingLocallyCount).toBe(1);
    expect(r.discrepancies.missing_locally.sample[0]).toMatchObject({
      partnerPatientId: "P-9",
    });
  });

  it("reports a link we hold that the portal no longer lists", () => {
    const r = reconcileIntegrationSource(
      SOURCE,
      [],
      [local({ partnerPatientId: "P-3" })],
    );
    expect(r.missingInPortalCount).toBe(1);
  });

  it("matches ids case- and whitespace-insensitively", () => {
    // Portal exports are hand-run and routinely differ in case or carry a
    // trailing space. Treating that as a missing patient would report the
    // whole roster as broken.
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ partnerPatientId: " p-1 " })],
      [local({ partnerPatientId: "P-1" })],
    );
    expect(r.matchedCount).toBe(1);
    expect(r.missingLocallyCount).toBe(0);
    expect(r.missingInPortalCount).toBe(0);
  });

  it("counts both sides even with no overlap at all", () => {
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ partnerPatientId: "A" }), portal({ partnerPatientId: "B" })],
      [local({ partnerPatientId: "C" })],
    );
    expect(r.portalRows).toBe(2);
    expect(r.localRows).toBe(1);
    expect(r.matchedCount).toBe(0);
    expect(r.missingLocallyCount).toBe(2);
    expect(r.missingInPortalCount).toBe(1);
  });
});

describe("reconcileIntegrationSource — device serials", () => {
  it("flags a genuine device swap", () => {
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ deviceSerial: "SN-2222" })],
      [local({ deviceSerial: "SN-1111" })],
    );
    expect(r.discrepancies.device_serial_mismatch.count).toBe(1);
    expect(r.mismatchedCount).toBe(1);
  });

  it("ignores separator and case drift in a serial", () => {
    // Serials get transcribed by hand into portals. "SN-123" and "sn123"
    // are the same machine, and reporting them as a swap sends a CSR
    // chasing equipment that never moved.
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ deviceSerial: "SN-123" })],
      [local({ deviceSerial: "sn123" })],
    );
    expect(r.discrepancies.device_serial_mismatch.count).toBe(0);
  });

  it("does not call a one-sided serial a mismatch", () => {
    // An export without a serial column is an incomplete export, not a
    // device swap.
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ deviceSerial: null })],
      [local({ deviceSerial: "SN-1" })],
    );
    expect(r.discrepancies.device_serial_mismatch.count).toBe(0);
    expect(r.mismatchedCount).toBe(0);
  });
});

describe("reconcileIntegrationSource — therapy data", () => {
  it("tolerates a one-night difference by default", () => {
    // The portal and the sync run at different times in different
    // timezones, so the most recent night is routinely on one side and
    // not the other. Zero tolerance would report every patient in the
    // practice, which is indistinguishable from reporting none.
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ nightsWithUsage: 28 })],
      [local({ nightsWithUsage: 27 })],
    );
    expect(r.discrepancies.night_count_mismatch.count).toBe(0);
  });

  it("flags a real gap in night counts", () => {
    // This is the one that matters clinically: compliance decisions and
    // resupply eligibility are made from these numbers.
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ nightsWithUsage: 28 })],
      [local({ nightsWithUsage: 12 })],
    );
    expect(r.discrepancies.night_count_mismatch.count).toBe(1);
    expect(r.discrepancies.night_count_mismatch.sample[0]).toMatchObject({
      portal: "28",
      local: "12",
    });
  });

  it("tolerates rounding in average usage", () => {
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ avgUsageMinutes: 372 })],
      [local({ avgUsageMinutes: 365 })],
    );
    expect(r.discrepancies.usage_mismatch.count).toBe(0);
  });

  it("flags a real usage gap", () => {
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ avgUsageMinutes: 400 })],
      [local({ avgUsageMinutes: 120 })],
    );
    expect(r.discrepancies.usage_mismatch.count).toBe(1);
  });

  it("counts a patient with several problems once", () => {
    // Otherwise a handful of badly-synced patients look like a practice
    // -wide failure.
    const r = reconcileIntegrationSource(
      SOURCE,
      [
        portal({
          deviceSerial: "A",
          nightsWithUsage: 30,
          avgUsageMinutes: 400,
        }),
      ],
      [local({ deviceSerial: "B", nightsWithUsage: 2, avgUsageMinutes: 30 })],
    );
    expect(r.mismatchedCount).toBe(1);
    expect(r.discrepancies.device_serial_mismatch.count).toBe(1);
    expect(r.discrepancies.night_count_mismatch.count).toBe(1);
    expect(r.discrepancies.usage_mismatch.count).toBe(1);
  });

  it("skips a comparison either side is missing", () => {
    const r = reconcileIntegrationSource(
      SOURCE,
      [portal({ nightsWithUsage: 30 })],
      [local({ nightsWithUsage: null })],
    );
    expect(r.mismatchedCount).toBe(0);
  });
});

describe("reconcileIntegrationSource — bounded output", () => {
  it("caps the id sample so a big practice cannot bloat the stored row", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      portal({ partnerPatientId: `P-${i}` }),
    );
    const r = reconcileIntegrationSource(SOURCE, rows, [], { sampleSize: 5 });
    expect(r.missingLocallyCount).toBe(500);
    expect(r.discrepancies.missing_locally.sample).toHaveLength(5);
  });

  it("returns a zeroed report for two empty sides", () => {
    const r = reconcileIntegrationSource(SOURCE, [], []);
    expect(r).toMatchObject({
      portalRows: 0,
      localRows: 0,
      matchedCount: 0,
      missingLocallyCount: 0,
      missingInPortalCount: 0,
      mismatchedCount: 0,
    });
  });

  it("honours a caller's tolerances", () => {
    const strict = reconcileIntegrationSource(
      SOURCE,
      [portal({ nightsWithUsage: 28 })],
      [local({ nightsWithUsage: 27 })],
      { nightToleranceDays: 0 },
    );
    expect(strict.discrepancies.night_count_mismatch.count).toBe(1);
  });
});
