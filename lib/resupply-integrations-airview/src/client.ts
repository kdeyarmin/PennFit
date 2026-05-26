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

class ClientError extends Error {
  constructor(public readonly kind: AdapterError) {
    super(kind);
  }
}

// Per-call timeouts so a hanging upstream (ResMed AirView) can't stall
// the in-process worker indefinitely. Defaults match the original
// hardcoded values; env overrides exist so ops can extend them under
// a partner-side incident without a deploy.
const DEFAULT_OAUTH_TIMEOUT_MS = 30_000;
const DEFAULT_API_TIMEOUT_MS = 60_000;

/**
 * Reads an environment variable and returns a validated timeout value in milliseconds.
 *
 * Accepts only a positive integer string; if the variable is missing or invalid the provided `fallback` is returned.
 *
 * @param name - The environment variable name to read
 * @param fallback - The fallback timeout in milliseconds to use when the env var is missing or invalid
 * @returns The parsed timeout in milliseconds, capped at 5 minutes (300000 ms), or `fallback` when parsing fails
 */
function parseTimeoutEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  // Strict digits-only check. `Number.parseInt("1e3", 10)` returns 1
  // and `Number.parseInt("30000ms", 10)` returns 30000 — both would
  // silently misconfigure the timeout. Reject anything that isn't a
  // pure positive integer.
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n <= 0) return fallback;
  // Cap at 5 minutes so a misconfigured value can't park a worker
  // task forever; ops can lift the cap with a code change if a real
  // partner outage justifies it.
  return Math.min(n, 5 * 60_000);
}

const OAUTH_TIMEOUT_MS = parseTimeoutEnv(
  "RESUPPLY_AIRVIEW_OAUTH_TIMEOUT_MS",
  DEFAULT_OAUTH_TIMEOUT_MS,
);
const API_TIMEOUT_MS = parseTimeoutEnv(
  "RESUPPLY_AIRVIEW_API_TIMEOUT_MS",
  DEFAULT_API_TIMEOUT_MS,
);

/**
 * Performs an HTTP fetch with a hard deadline and maps common timeout/network failures to a `ClientError` with kind `"unavailable"`.
 *
 * @param url - The request URL
 * @param init - Fetch init options (headers, method, body, etc.)
 * @param timeoutMs - Milliseconds to wait before aborting the request
 * @returns The successful fetch `Response`
 * @throws ClientError with kind `"unavailable"` when the request times out or a common network/abort error occurs
 * @throws Re-throws any other errors thrown by `fetch`
 */
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
  const res = await fetchWithTimeout(
    config.oauthTokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    OAUTH_TIMEOUT_MS,
  );
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

async function request<T>(
  config: AirviewConfig,
  path: string,
): Promise<T> {
  const token = await getAccessToken(config);
  const res = await fetchWithTimeout(
    `${config.apiBaseUrl}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-DME-Id": config.dmeId,
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
  // CMS adherence is measured over ONE 30-consecutive-day window
  // (>=4h on >=21 days), not the whole fetched window. Restrict the
  // compliance flag to the most recent 30 days of data so a >30-day
  // lookback can't over-report. nightDate is an ISO YYYY-MM-DD string
  // (sorts lexically). Mirrors adherence-predictor.ts's slice(-30).
  const recentOverFour = [...withData]
    .sort((a, b) => a.nightDate.localeCompare(b.nightDate))
    .slice(-30)
    .filter((n) => (n.usageMinutes ?? 0) >= 240);
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
    meetsCmsCompliance: recentOverFour.length >= 21,
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
