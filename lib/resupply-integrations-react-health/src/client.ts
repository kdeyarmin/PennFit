// React Health (3B Medical iCode Connect) HTTP client.
//
// Endpoint paths are placeholders modelled after the documented
// iCode Connect partner surface — every request runs through
// `request()` so a future swap to a final spec is one place. The
// 3B docs follow OAuth2 client_credentials, JSON resources at
// /v1/account/{accountId}/patients/{partnerPatientId}/... and an
// X-Account-Id header that mirrors AirView's X-DME-Id pattern.
//
// Loaded only when ReactHealthConfig is non-null (see adapter.ts).

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

import type { ReactHealthConfig } from "./config";

interface OauthToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: { configKey: string; token: OauthToken } | null = null;

function configKey(config: ReactHealthConfig): string {
  return `${config.oauthTokenUrl}|${config.clientId}|${config.accountId}`;
}

class ClientError extends Error {
  constructor(public readonly kind: AdapterError) {
    super(kind);
  }
}

// Per-call timeouts so a hanging upstream (3B Medical iCode Connect)
// can't stall the in-process worker indefinitely. Token round-trips
// are short; data fetches paginate server-side.
const OAUTH_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout → DOMException("TimeoutError"); fetch network
    // failures → TypeError. Both mean "upstream unreachable."
    if (err instanceof Error) {
      const name = err.name;
      if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
        throw new ClientError("unavailable");
      }
    }
    throw err;
  }
}

async function getAccessToken(config: ReactHealthConfig): Promise<string> {
  const key = configKey(config);
  if (
    cachedToken &&
    cachedToken.configKey === key &&
    cachedToken.token.expiresAt > Date.now() + 30_000
  ) {
    return cachedToken.token.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: `account:${config.accountId}`,
  });
  const res = await fetchWithTimeout(
    config.oauthTokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    OAUTH_TIMEOUT_MS,
  );
  if (!res.ok) throw new ClientError("auth_failed");
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

async function request<T>(
  config: ReactHealthConfig,
  path: string,
): Promise<T> {
  const token = await getAccessToken(config);
  const res = await fetchWithTimeout(
    `${config.apiBaseUrl}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-Account-Id": config.accountId,
      },
    },
    API_TIMEOUT_MS,
  );
  if (res.status === 404) throw new ClientError("not_found");
  if (res.status === 401 || res.status === 403) {
    throw new ClientError("auth_failed");
  }
  if (res.status === 429) throw new ClientError("rate_limited");
  if (res.status >= 500) throw new ClientError("unavailable");
  if (!res.ok) throw new ClientError("unknown_error");
  return (await res.json()) as T;
}

interface ReactHealthDeviceResponse {
  model?: string | null;
  serialNumber?: string | null;
  mode?: string | null;
  pressureMin?: number | null;
  pressureMax?: number | null;
  rampMinutes?: number | null;
  humidifierLevel?: number | null;
  maskType?: string | null;
}

interface ReactHealthNightResponse {
  date: string;
  usageMinutes?: number | null;
  ahi?: number | null;
  leakRate?: number | null;
  pressure95?: number | null;
}

interface ReactHealthSupplyResponse {
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
  // 3B uses "water_chamber" for Aura iCH humidifier consumables.
  water_chamber: "humidifier_chamber",
};

function mapSupply(raw: ReactHealthSupplyResponse): SupplyItem {
  const key = (raw.category ?? "").toLowerCase().replace(/\s+/g, "_");
  return {
    category: SUPPLY_CATEGORY_MAP[key] ?? "other",
    description: raw.description ?? "",
    lastReplacedDate: raw.lastReplacedDate ?? null,
    nextEligibleDate: raw.nextEligibleDate ?? null,
  };
}

function mapDeviceSettings(raw: ReactHealthDeviceResponse): DeviceSettings {
  return {
    deviceModel: raw.model ?? null,
    deviceSerial: raw.serialNumber ?? null,
    therapyMode: raw.mode ?? null,
    pressureMinCmh2o: raw.pressureMin ?? null,
    pressureMaxCmh2o: raw.pressureMax ?? null,
    rampMinutes: raw.rampMinutes ?? null,
    humidifierLevel: raw.humidifierLevel ?? null,
    maskType: raw.maskType ?? null,
  };
}

function mapNight(raw: ReactHealthNightResponse): TherapyNight {
  return {
    nightDate: raw.date,
    usageMinutes: raw.usageMinutes ?? null,
    ahi: raw.ahi ?? null,
    leakRateLMin: raw.leakRate ?? null,
    pressureP95Cmh2o: raw.pressure95 ?? null,
  };
}

function summariseCompliance(
  nights: TherapyNight[],
  windowDays: number,
): ComplianceSummary {
  const withData = nights.filter((n) => n.usageMinutes !== null);
  const overFour = withData.filter((n) => (n.usageMinutes ?? 0) >= 240);
  // CMS adherence is measured over ONE 30-consecutive-day window
  // (>=4h on >=21 days), not the whole fetched window. Restrict the
  // compliance flag to the most recent 30 days of data so a >30-day
  // lookback can't over-report. nightDate is an ISO YYYY-MM-DD string
  // (sorts lexically). Mirrors adherence-predictor.ts's slice(-30).
  const recentOverFour = [...withData]
    .sort((a, b) => a.nightDate.localeCompare(b.nightDate))
    .slice(-30)
    .filter((n) => (n.usageMinutes ?? 0) >= 240);
  const totalMins = withData.reduce(
    (s, n) => s + (n.usageMinutes ?? 0),
    0,
  );
  const ahiVals = withData
    .map((n) => n.ahi)
    .filter((v): v is number => v !== null);
  const avgAhi =
    ahiVals.length > 0
      ? ahiVals.reduce((s, v) => s + v, 0) / ahiVals.length
      : null;
  return {
    windowDays,
    daysWithData: withData.length,
    daysOver4Hours: overFour.length,
    averageUsageMinutes:
      withData.length > 0 ? totalMins / withData.length : null,
    averageAhi: avgAhi,
    meetsCmsCompliance: recentOverFour.length >= 21,
  };
}

export async function fetchReactHealthSnapshot(
  config: ReactHealthConfig,
  input: FetchSnapshotInput,
): Promise<FetchSnapshotResult> {
  const windowDays = input.windowDays ?? 30;
  const pid = encodeURIComponent(input.partnerPatientId);
  try {
    const [device, therapy, supplies] = await Promise.all([
      request<ReactHealthDeviceResponse>(config, `/v1/patients/${pid}/device`),
      request<{ nights: ReactHealthNightResponse[] }>(
        config,
        `/v1/patients/${pid}/therapy?windowDays=${windowDays}`,
      ),
      request<{ items: ReactHealthSupplyResponse[] }>(
        config,
        `/v1/patients/${pid}/supplies`,
      ),
    ]);
    const recentNights = (therapy.nights ?? []).map(mapNight);
    const snapshot: IntegrationSnapshot = {
      source: "react_health",
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
