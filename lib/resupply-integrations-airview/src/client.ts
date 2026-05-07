// ResMed AirView HTTP client. Speaks the partner OAuth2
// client_credentials flow + the read-only patient endpoints
// (/v1/patients/{id}, /v1/patients/{id}/therapy, /v1/patients/{id}/devices,
// /v1/patients/{id}/supplies). Endpoint paths are placeholders until
// the partnership ships a final spec — every request runs through
// `request()` so a future swap is a one-place change.
//
// Errors are normalised into the AdapterError union; partner
// response bodies never leak into logs or thrown errors.
//
// This file is only loaded when AirviewConfig is non-null (see
// adapter.ts). It has no module-level side effects.

import type {
  AdapterError,
  ComplianceSummary,
  DeviceSettings,
  FetchSnapshotInput,
  FetchSnapshotResult,
  IntegrationSnapshot,
  SupplyItem,
  TherapyNight,
} from "@workspace/resupply-integrations";

import type { AirviewConfig } from "./config";

interface OauthToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: { configKey: string; token: OauthToken } | null = null;

function configKey(config: AirviewConfig): string {
  return `${config.oauthTokenUrl}|${config.clientId}|${config.dmeId}`;
}

async function getAccessToken(config: AirviewConfig): Promise<string> {
  const key = configKey(config);
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.configKey === key &&
    cachedToken.token.expiresAt > now + 30_000
  ) {
    return cachedToken.token.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: `dme:${config.dmeId}`,
  });
  const res = await fetch(config.oauthTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new ClientError("auth_failed");
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new ClientError("auth_failed");
  cachedToken = {
    configKey: key,
    token: {
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    },
  };
  return json.access_token;
}

class ClientError extends Error {
  constructor(public readonly kind: AdapterError) {
    super(kind);
  }
}

async function request<T>(
  config: AirviewConfig,
  path: string,
): Promise<T> {
  const token = await getAccessToken(config);
  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-DME-Id": config.dmeId,
    },
  });
  if (res.status === 404) throw new ClientError("not_found");
  if (res.status === 401 || res.status === 403) {
    throw new ClientError("auth_failed");
  }
  if (res.status === 429) throw new ClientError("rate_limited");
  if (res.status >= 500) throw new ClientError("unavailable");
  if (!res.ok) throw new ClientError("unknown_error");
  return (await res.json()) as T;
}

interface AirviewDeviceResponse {
  model?: string | null;
  serialNumber?: string | null;
  therapyMode?: string | null;
  pressureMin?: number | null;
  pressureMax?: number | null;
  rampMinutes?: number | null;
  humidifierLevel?: number | null;
  maskType?: string | null;
}

interface AirviewTherapyNightResponse {
  date: string;
  usageMinutes?: number | null;
  ahi?: number | null;
  leakRate?: number | null;
  pressureP95?: number | null;
}

interface AirviewSupplyResponse {
  category?: string;
  description?: string;
  lastReplacedDate?: string | null;
  nextEligibleDate?: string | null;
}

const SUPPLY_CATEGORY_MAP: Record<string, SupplyItem["category"]> = {
  mask: "mask",
  cushion: "cushion",
  headgear: "headgear",
  tubing: "tubing",
  filter: "filter",
  humidifier_chamber: "humidifier_chamber",
  humidifierchamber: "humidifier_chamber",
};

function mapSupply(raw: AirviewSupplyResponse): SupplyItem {
  const key = (raw.category ?? "").toLowerCase().replace(/\s+/g, "_");
  return {
    category: SUPPLY_CATEGORY_MAP[key] ?? "other",
    description: raw.description ?? "",
    lastReplacedDate: raw.lastReplacedDate ?? null,
    nextEligibleDate: raw.nextEligibleDate ?? null,
  };
}

function mapDeviceSettings(raw: AirviewDeviceResponse): DeviceSettings {
  return {
    deviceModel: raw.model ?? null,
    deviceSerial: raw.serialNumber ?? null,
    therapyMode: raw.therapyMode ?? null,
    pressureMinCmh2o: raw.pressureMin ?? null,
    pressureMaxCmh2o: raw.pressureMax ?? null,
    rampMinutes: raw.rampMinutes ?? null,
    humidifierLevel: raw.humidifierLevel ?? null,
    maskType: raw.maskType ?? null,
  };
}

function mapNight(raw: AirviewTherapyNightResponse): TherapyNight {
  return {
    nightDate: raw.date,
    usageMinutes: raw.usageMinutes ?? null,
    ahi: raw.ahi ?? null,
    leakRateLMin: raw.leakRate ?? null,
    pressureP95Cmh2o: raw.pressureP95 ?? null,
  };
}

function summariseCompliance(
  nights: TherapyNight[],
  windowDays: number,
): ComplianceSummary {
  const withData = nights.filter((n) => n.usageMinutes !== null);
  const overFour = withData.filter((n) => (n.usageMinutes ?? 0) >= 240);
  const totalMins = withData.reduce((s, n) => s + (n.usageMinutes ?? 0), 0);
  const ahiVals = withData
    .map((n) => n.ahi)
    .filter((v): v is number => v !== null);
  const avgAhi =
    ahiVals.length > 0 ? ahiVals.reduce((s, v) => s + v, 0) / ahiVals.length : null;
  return {
    windowDays,
    daysWithData: withData.length,
    daysOver4Hours: overFour.length,
    averageUsageMinutes: withData.length > 0 ? totalMins / withData.length : null,
    averageAhi: avgAhi,
    meetsCmsCompliance: overFour.length >= 21,
  };
}

export async function fetchAirviewSnapshot(
  config: AirviewConfig,
  input: FetchSnapshotInput,
): Promise<FetchSnapshotResult> {
  const windowDays = input.windowDays ?? 30;
  const pid = encodeURIComponent(input.partnerPatientId);
  try {
    const [device, therapy, supplies] = await Promise.all([
      request<AirviewDeviceResponse>(config, `/v1/patients/${pid}/devices`),
      request<{ nights: AirviewTherapyNightResponse[] }>(
        config,
        `/v1/patients/${pid}/therapy?windowDays=${windowDays}`,
      ),
      request<{ items: AirviewSupplyResponse[] }>(
        config,
        `/v1/patients/${pid}/supplies`,
      ),
    ]);
    const recentNights = (therapy.nights ?? []).map(mapNight);
    const snapshot: IntegrationSnapshot = {
      source: "resmed_airview",
      partnerPatientId: input.partnerPatientId,
      settings: mapDeviceSettings(device),
      compliance: summariseCompliance(recentNights, windowDays),
      recentNights,
      supplies: (supplies.items ?? []).map(mapSupply),
    };
    return { ok: true, snapshot };
  } catch (err) {
    if (err instanceof ClientError) {
      return { ok: false, error: err.kind };
    }
    return { ok: false, error: "unknown_error" };
  }
}
