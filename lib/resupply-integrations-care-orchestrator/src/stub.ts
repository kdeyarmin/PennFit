// Deterministic stub for Care Orchestrator. Mirrors the AirView
// stub but with Philips-flavoured device strings so the side-by-
// side comparison in the admin UI is obvious in dev/preview.

import type {
  IntegrationSnapshot,
  TherapyNight,
} from "@workspace/resupply-integrations";

export function buildCareOrchestratorStubSnapshot(
  partnerPatientId: string,
  windowDays: number,
): IntegrationSnapshot {
  const recentNights = buildStubNights(windowDays);
  const withData = recentNights.filter((n) => n.usageMinutes !== null);
  const overFour = withData.filter((n) => (n.usageMinutes ?? 0) >= 240);
  const totalMins = withData.reduce((s, n) => s + (n.usageMinutes ?? 0), 0);

  return {
    source: "philips_care",
    partnerPatientId,
    settings: {
      deviceModel: "STUB-DreamStation 2 Auto",
      deviceSerial: "STUB-PR-0000",
      therapyMode: "Auto-CPAP",
      pressureMinCmh2o: 7,
      pressureMaxCmh2o: 15,
      rampMinutes: 30,
      humidifierLevel: 3,
      maskType: "STUB-DreamWear Nasal",
    },
    compliance: {
      windowDays,
      daysWithData: withData.length,
      daysOver4Hours: overFour.length,
      averageUsageMinutes: withData.length > 0 ? totalMins / withData.length : null,
      averageAhi: 5.1,
      meetsCmsCompliance: overFour.length >= 21,
    },
    recentNights,
    supplies: [
      {
        category: "mask",
        description: "STUB-DreamWear Nasal Mask",
        lastReplacedDate: "2025-10-20",
        nextEligibleDate: "2026-04-20",
      },
      {
        category: "filter",
        description: "STUB-Pollen Filter (Disposable)",
        lastReplacedDate: "2026-02-01",
        nextEligibleDate: "2026-03-01",
      },
      {
        category: "humidifier_chamber",
        description: "STUB-Humidifier Water Tank",
        lastReplacedDate: "2025-08-15",
        nextEligibleDate: "2026-02-15",
      },
    ],
  };
}

function buildStubNights(windowDays: number): TherapyNight[] {
  const today = new Date();
  const out: TherapyNight[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const missed = i % 9 === 8;
    out.push({
      nightDate: iso,
      usageMinutes: missed ? null : 300 + ((i * 17) % 120),
      ahi: missed ? null : 4 + ((i * 11) % 6) / 2,
      leakRateLMin: missed ? null : 18 + ((i * 7) % 10),
      pressureP95Cmh2o: missed ? null : 10 + ((i * 5) % 4) / 2,
    });
  }
  return out;
}
