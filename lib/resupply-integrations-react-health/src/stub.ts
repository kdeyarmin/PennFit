// Deterministic stub for React Health (3B Medical iCode Connect).
// Lets the rest of the system — API routes, UI tabs, audit
// envelopes — be exercised end-to-end in dev/preview without
// partner credentials.
//
// Values are obvious placeholders ("STUB-…") so a screenshot from
// a stub session can never be mistaken for production data.

import type {
  IntegrationSnapshot,
  TherapyNight,
} from "@workspace/resupply-integrations";

export function buildReactHealthStubSnapshot(
  partnerPatientId: string,
  windowDays: number,
): IntegrationSnapshot {
  const recentNights = buildStubNights(windowDays);
  const daysWithData = recentNights.filter(
    (n) => n.usageMinutes !== null,
  ).length;
  const daysOver4 = recentNights.filter(
    (n) => (n.usageMinutes ?? 0) >= 240,
  ).length;
  const totalMins = recentNights.reduce(
    (s, n) => s + (n.usageMinutes ?? 0),
    0,
  );
  const avgUsage = daysWithData > 0 ? totalMins / daysWithData : null;

  return {
    source: "react_health",
    partnerPatientId,
    settings: {
      // Luna G3 is the most common 3B Medical CPAP. AVAPS, BiPAP,
      // and APAP-Auto variants all share the iCode Connect cloud.
      deviceModel: "STUB-Luna G3 APAP",
      deviceSerial: "STUB-RH-0000",
      therapyMode: "APAP-Auto",
      pressureMinCmh2o: 5,
      pressureMaxCmh2o: 15,
      rampMinutes: 15,
      humidifierLevel: 3,
      maskType: "STUB-Wisp Nasal",
    },
    compliance: {
      windowDays,
      daysWithData,
      daysOver4Hours: daysOver4,
      averageUsageMinutes: avgUsage,
      averageAhi: 3.8,
      meetsCmsCompliance: daysOver4 >= 21,
    },
    recentNights,
    supplies: [
      {
        category: "mask",
        description: "STUB-Wisp Nasal Mask",
        lastReplacedDate: "2025-10-20",
        nextEligibleDate: "2026-04-20",
      },
      {
        category: "filter",
        description: "STUB-Disposable Ultra-Fine Filter",
        lastReplacedDate: "2026-02-01",
        nextEligibleDate: "2026-03-01",
      },
      {
        category: "tubing",
        description: "STUB-Heated Tubing 6ft",
        lastReplacedDate: "2025-08-15",
        nextEligibleDate: "2026-02-15",
      },
    ],
  };
}

function buildStubNights(windowDays: number): TherapyNight[] {
  const today = new Date();
  const out: TherapyNight[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    // Skip every 8th night to give the stub a slightly different
    // missing-night cadence than AirView's every-7th — so a
    // multi-vendor patient view doesn't look like one vendor.
    const missed = i % 8 === 7;
    out.push({
      nightDate: iso,
      usageMinutes: missed ? null : 330 + ((i * 11) % 110),
      ahi: missed ? null : 2.5 + ((i * 5) % 7) / 2,
      leakRateLMin: missed ? null : 10 + ((i * 4) % 10),
      pressureP95Cmh2o: missed ? null : 8 + ((i * 3) % 5) / 2,
    });
  }
  return out;
}
