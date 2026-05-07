// Health Connect stub. Patient-push integrations don't have a
// "device settings" / "compliance" surface in the same way the
// vendor pulls do — what we get is mostly steps / sleep / heart
// rate. We surface those by mapping sleep duration into the
// `usageMinutes` slot so the admin UI's existing rendering
// works without a separate code path.

import type { IntegrationSnapshot } from "@workspace/resupply-integrations";

export function buildHealthConnectStubSnapshot(
  partnerPatientId: string,
  windowDays: number,
): IntegrationSnapshot {
  const today = new Date();
  const recentNights = Array.from({ length: windowDays }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const missed = i % 11 === 10;
    return {
      nightDate: iso,
      // Sleep duration in minutes from Health Connect.
      usageMinutes: missed ? null : 380 + ((i * 9) % 100),
      // No AHI / leak / pressure from a wearable feed.
      ahi: null,
      leakRateLMin: null,
      pressureP95Cmh2o: null,
    };
  });
  const withData = recentNights.filter((n) => n.usageMinutes !== null);
  const overFour = withData.filter((n) => (n.usageMinutes ?? 0) >= 240);
  const totalMins = withData.reduce((s, n) => s + (n.usageMinutes ?? 0), 0);

  return {
    source: "health_connect",
    partnerPatientId,
    settings: null,
    compliance: {
      windowDays,
      daysWithData: withData.length,
      daysOver4Hours: overFour.length,
      averageUsageMinutes:
        withData.length > 0 ? totalMins / withData.length : null,
      averageAhi: null,
      meetsCmsCompliance: false,
    },
    recentNights,
    supplies: [],
  };
}
