// Deterministic stub for AirView. Lets the rest of the system —
// API routes, UI tabs, audit envelopes — be exercised end-to-end
// in dev/preview without partner credentials.
//
// The values are obvious placeholders ("STUB-…") so a screenshot
// from a stub session can never be mistaken for production data.

import type {
  IntegrationSnapshot,
  TherapyNight,
} from "@workspace/resupply-integrations";

export function buildAirviewStubSnapshot(
  partnerPatientId: string,
  windowDays: number,
): IntegrationSnapshot {
  const recentNights = buildStubNights(windowDays);
  const daysWithData = recentNights.filter((n) => n.usageMinutes !== null)
    .length;
  const daysOver4 = recentNights.filter(
    (n) => (n.usageMinutes ?? 0) >= 240,
  ).length;
  const totalMins = recentNights.reduce((s, n) => s + (n.usageMinutes ?? 0), 0);
  const avgUsage = daysWithData > 0 ? totalMins / daysWithData : null;

  return {
    source: "resmed_airview",
    partnerPatientId,
    settings: {
      deviceModel: "STUB-AirSense 11 AutoSet",
      deviceSerial: "STUB-SN-0000",
      therapyMode: "AutoSet",
      pressureMinCmh2o: 6,
      pressureMaxCmh2o: 14,
      rampMinutes: 20,
      humidifierLevel: 4,
      maskType: "STUB-AirFit F30",
    },
    compliance: {
      windowDays,
      daysWithData,
      daysOver4Hours: daysOver4,
      averageUsageMinutes: avgUsage,
      averageAhi: 4.2,
      meetsCmsCompliance: daysOver4 >= 21,
    },
    recentNights,
    supplies: [
      {
        category: "mask",
        description: "STUB-AirFit F30 Full Face Mask",
        lastReplacedDate: "2025-11-01",
        nextEligibleDate: "2026-05-01",
      },
      {
        category: "cushion",
        description: "STUB-AirFit F30 Cushion",
        lastReplacedDate: "2026-01-15",
        nextEligibleDate: "2026-03-15",
      },
      {
        category: "tubing",
        description: "STUB-ClimateLineAir Heated Tube",
        lastReplacedDate: "2025-09-10",
        nextEligibleDate: "2026-03-10",
      },
    ],
  };
}

function buildStubNights(windowDays: number): TherapyNight[] {
  // Reference date is fixed-ish per partner id so the same patient
  // sees stable values between refreshes within a single dev session.
  const today = new Date();
  const out: TherapyNight[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    // Skip every 7th night to demonstrate "missed nights" rendering.
    const missed = i % 7 === 6;
    out.push({
      nightDate: iso,
      usageMinutes: missed ? null : 360 + ((i * 13) % 90),
      ahi: missed ? null : 3 + ((i * 7) % 5) / 2,
      leakRateLMin: missed ? null : 12 + ((i * 5) % 8),
      pressureP95Cmh2o: missed ? null : 9 + ((i * 3) % 4) / 2,
    });
  }
  return out;
}
