// Care Orchestrator HTTP client. Endpoint paths follow the public
// Philips DME developer docs at the time of writing; once the
// partnership ships a final spec the request paths can be tweaked
// in one place. All errors are normalised into AdapterError.
//
// Loaded only when CareOrchestratorConfig is non-null.

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

import type { CareOrchestratorConfig } from "./config";

interface OauthToken {
  accessToken: string;
  expiresAt: number;
}
let cachedToken: { configKey: string; token: OauthToken } | null = null;

function configKey(config: CareOrchestratorConfig): string {
  return `${config.oauthTokenUrl}|${config.clientId}|${config.partnerId}`;
}

class ClientError extends Error {
  constructor(public readonly kind: AdapterError) {
    super(kind);
  }
}

// Per-call timeouts so a hanging upstream (Philips Care Orchestrator)
// can't stall the in-process worker indefinitely.
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
    if (err instanceof Error) {
      const name = err.name;
      if (name === "TimeoutError" || name === "AbortError" || name === "TypeError") {
        throw new ClientError("unavailable");
      }
    }
    throw err;
  }
}

async function getAccessToken(
  config: CareOrchestratorConfig,
): Promise<string> {
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
    scope: `partner:${config.partnerId}`,
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
  config: CareOrchestratorConfig,
  path: string,
): Promise<T> {
  const token = await getAccessToken(config);
  const res = await fetchWithTimeout(
    `${config.apiBaseUrl}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-Partner-Id": config.partnerId,
      },
    },
    API_TIMEOUT_MS,
  );
  if (res.status === 404) throw new ClientError("not_found");
  if (res.status === 401 || res.status === 403)
    throw new ClientError("auth_failed");
  if (res.status === 429) throw new ClientError("rate_limited");
  if (res.status >= 500) throw new ClientError("unavailable");
  if (!res.ok) throw new ClientError("unknown_error");
  return (await res.json()) as T;
}

interface CoDeviceResponse {
  modelName?: string | null;
  serialNumber?: string | null;
  therapyMode?: string | null;
  minPressure?: number | null;
  maxPressure?: number | null;
  rampTimeMinutes?: number | null;
  humidifierSetting?: number | null;
  maskName?: string | null;
}
interface CoNightResponse {
  sessionDate: string;
  usageMinutes?: number | null;
  ahi?: number | null;
  largeLeak?: number | null;
  pressure90?: number | null;
}
interface CoSupplyResponse {
  type?: string;
  name?: string;
  lastReplaced?: string | null;
  nextEligible?: string | null;
}

const SUPPLY_CATEGORY_MAP: Record<string, SupplyItem["category"]> = {
  mask: "mask",
  cushion: "cushion",
  headgear: "headgear",
  tubing: "tubing",
  filter: "filter",
  humidifier_chamber: "humidifier_chamber",
  watertank: "humidifier_chamber",
  water_tank: "humidifier_chamber",
};

function mapSettings(raw: CoDeviceResponse): DeviceSettings {
  return {
    deviceModel: raw.modelName ?? null,
    deviceSerial: raw.serialNumber ?? null,
    therapyMode: raw.therapyMode ?? null,
    pressureMinCmh2o: raw.minPressure ?? null,
    pressureMaxCmh2o: raw.maxPressure ?? null,
    rampMinutes: raw.rampTimeMinutes ?? null,
    humidifierLevel: raw.humidifierSetting ?? null,
    maskType: raw.maskName ?? null,
  };
}

function mapNight(raw: CoNightResponse): TherapyNight {
  return {
    nightDate: raw.sessionDate,
    usageMinutes: raw.usageMinutes ?? null,
    ahi: raw.ahi ?? null,
    leakRateLMin: raw.largeLeak ?? null,
    pressureP95Cmh2o: raw.pressure90 ?? null,
  };
}

function mapSupply(raw: CoSupplyResponse): SupplyItem {
  const key = (raw.type ?? "").toLowerCase().replace(/\s+/g, "_");
  return {
    category: SUPPLY_CATEGORY_MAP[key] ?? "other",
    description: raw.name ?? "",
    lastReplacedDate: raw.lastReplaced ?? null,
    nextEligibleDate: raw.nextEligible ?? null,
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
  return {
    windowDays,
    daysWithData: withData.length,
    daysOver4Hours: overFour.length,
    averageUsageMinutes:
      withData.length > 0 ? totalMins / withData.length : null,
    averageAhi:
      ahiVals.length > 0 ? ahiVals.reduce((s, v) => s + v, 0) / ahiVals.length : null,
    meetsCmsCompliance: overFour.length >= 21,
  };
}

export async function fetchCareOrchestratorSnapshot(
  config: CareOrchestratorConfig,
  input: FetchSnapshotInput,
): Promise<FetchSnapshotResult> {
  const windowDays = input.windowDays ?? 30;
  const pid = encodeURIComponent(input.partnerPatientId);
  try {
    const [device, therapy, supplies] = await Promise.all([
      request<CoDeviceResponse>(config, `/v1/patients/${pid}/device`),
      request<{ sessions: CoNightResponse[] }>(
        config,
        `/v1/patients/${pid}/sessions?windowDays=${windowDays}`,
      ),
      request<{ supplies: CoSupplyResponse[] }>(
        config,
        `/v1/patients/${pid}/supplies`,
      ),
    ]);
    const recentNights = (therapy.sessions ?? []).map(mapNight);
    const snapshot: IntegrationSnapshot = {
      source: "philips_care",
      partnerPatientId: input.partnerPatientId,
      settings: mapSettings(device),
      compliance: summariseCompliance(recentNights, windowDays),
      recentNights,
      supplies: (supplies.supplies ?? []).map(mapSupply),
    };
    return { ok: true, snapshot };
  } catch (err) {
    if (err instanceof ClientError) {
      return { ok: false, error: err.kind };
    }
    return { ok: false, error: "unknown_error" };
  }
}
