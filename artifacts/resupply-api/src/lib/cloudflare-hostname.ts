// Cloudflare for SaaS — Custom Hostnames client (ADR 021).
//
// Automates per-tenant custom-domain TLS: when a tenant's domain is
// verified, the app registers it as a Cloudflare custom hostname; Cloudflare
// then issues + auto-renews the certificate and routes the host to our
// origin. Tenants CNAME their domain to the zone's fallback hostname (the
// value operators put in PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET).
//
// This module is a thin, self-contained REST client (no SDK, no DB). It
// reads config at CALL time so credential rotation is honored without a
// restart, and exposes a `fetchImpl` test seam. Callers run it behind the
// `domains.tls_automation` feature flag and treat every failure as
// fail-soft — a Cloudflare hiccup must never break a tenant's verify (the
// domain is still "verified"; only TLS provisioning is deferred).

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
}

/** Read Cloudflare config from env at call time, or null when unset. */
export function readCloudflareConfigOrNull(): CloudflareConfig | null {
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const zoneId = (process.env.CLOUDFLARE_ZONE_ID ?? "").trim();
  if (!apiToken || !zoneId) return null;
  return { apiToken, zoneId };
}

/** True when the Cloudflare custom-hostname automation is configured. */
export function isCloudflareConfigured(): boolean {
  return readCloudflareConfigOrNull() !== null;
}

/** A DNS record the tenant must publish so Cloudflare can validate. */
export interface CloudflareValidation {
  type: "txt";
  name: string;
  value: string;
}

/** Our normalized view of a Cloudflare custom hostname. */
export interface CloudflareHostname {
  id: string;
  /** Mapped TLS lifecycle for the UI/DB. */
  tls: "pending" | "active" | "failed";
  /** Raw Cloudflare hostname + ssl status, for logs/debugging. */
  hostnameStatus: string;
  sslStatus: string;
  /** The record the tenant should publish while `tls === "pending"`. */
  validation: CloudflareValidation | null;
}

export class CloudflareError extends Error {
  readonly status: number | null;
  readonly cfErrors: Array<{ code: number; message: string }>;
  constructor(
    message: string,
    opts: {
      status?: number | null;
      cfErrors?: Array<{ code: number; message: string }>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "CloudflareError";
    this.status = opts.status ?? null;
    this.cfErrors = opts.cfErrors ?? [];
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

interface CfHostnameRaw {
  id: string;
  hostname: string;
  status?: string;
  ssl?: {
    status?: string;
    validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
}

interface ClientOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  config?: CloudflareConfig;
}

/** Map Cloudflare's hostname + ssl status onto our 3-state TLS lifecycle. */
function mapTls(
  hostnameStatus: string,
  sslStatus: string,
): CloudflareHostname["tls"] {
  const h = hostnameStatus.toLowerCase();
  const s = sslStatus.toLowerCase();
  if (s === "active" && (h === "active" || h === "")) return "active";
  if (
    /(error|timed_out|timeout|deleted|blocked|moved|deactivated|holding)/.test(
      `${h} ${s}`,
    )
  ) {
    return "failed";
  }
  // Everything else (pending_validation, pending_issuance, initializing,
  // pending_deployment, active_redeploying, …) is in-flight → keep polling.
  return "pending";
}

/** Pull the record the tenant must publish (DCV TXT, else ownership TXT). */
function extractValidation(raw: CfHostnameRaw): CloudflareValidation | null {
  const dcv = raw.ssl?.validation_records?.find(
    (r) => r.txt_name && r.txt_value,
  );
  if (dcv?.txt_name && dcv.txt_value) {
    return { type: "txt", name: dcv.txt_name, value: dcv.txt_value };
  }
  const ov = raw.ownership_verification;
  if (ov?.type === "txt" && ov.name && ov.value) {
    return { type: "txt", name: ov.name, value: ov.value };
  }
  return null;
}

function normalize(raw: CfHostnameRaw): CloudflareHostname {
  const hostnameStatus = raw.status ?? "";
  const sslStatus = raw.ssl?.status ?? "";
  return {
    id: raw.id,
    tls: mapTls(hostnameStatus, sslStatus),
    hostnameStatus,
    sslStatus,
    validation: extractValidation(raw),
  };
}

async function cfFetch<T>(
  path: string,
  init: RequestInit,
  opts: ClientOpts,
): Promise<CfEnvelope<T>> {
  const config = opts.config ?? readCloudflareConfigOrNull();
  if (!config) {
    throw new CloudflareError("Cloudflare is not configured.");
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetchFn(`${CF_API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new CloudflareError(
      timedOut ? "Cloudflare request timed out" : "Cloudflare request failed",
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  let body: CfEnvelope<T>;
  try {
    body = (await res.json()) as CfEnvelope<T>;
  } catch (err) {
    throw new CloudflareError(
      `Cloudflare response not JSON (HTTP ${res.status})`,
      {
        status: res.status,
        cause: err,
      },
    );
  }
  if (!res.ok || !body.success) {
    throw new CloudflareError(`Cloudflare API error (HTTP ${res.status})`, {
      status: res.status,
      cfErrors: body.errors ?? [],
    });
  }
  return body;
}

/** Find an existing custom hostname by its hostname, or null. */
export async function findCustomHostnameByHostname(
  hostname: string,
  opts: ClientOpts = {},
): Promise<CloudflareHostname | null> {
  const config = opts.config ?? readCloudflareConfigOrNull();
  if (!config) throw new CloudflareError("Cloudflare is not configured.");
  const body = await cfFetch<CfHostnameRaw[]>(
    `/zones/${config.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    { method: "GET" },
    opts,
  );
  const first = (body.result ?? [])[0];
  return first ? normalize(first) : null;
}

/**
 * Register a custom hostname (idempotent): creates it, or returns the
 * existing one if Cloudflare reports it already exists. TLS uses DV with
 * TXT validation so the tenant gets a deterministic record to publish.
 */
export async function createCustomHostname(
  hostname: string,
  opts: ClientOpts = {},
): Promise<CloudflareHostname> {
  const config = opts.config ?? readCloudflareConfigOrNull();
  if (!config) throw new CloudflareError("Cloudflare is not configured.");
  try {
    const body = await cfFetch<CfHostnameRaw>(
      `/zones/${config.zoneId}/custom_hostnames`,
      {
        method: "POST",
        body: JSON.stringify({
          hostname,
          ssl: {
            method: "txt",
            type: "dv",
            settings: { min_tls_version: "1.2" },
          },
        }),
      },
      opts,
    );
    return normalize(body.result);
  } catch (err) {
    // Idempotency: "already exists" (CF code 1406/1407) → fetch + return it.
    if (
      err instanceof CloudflareError &&
      err.cfErrors.some((e) => e.code === 1406 || e.code === 1407)
    ) {
      const existing = await findCustomHostnameByHostname(hostname, opts);
      if (existing) return existing;
    }
    throw err;
  }
}

/** Refresh a custom hostname's current status. */
export async function getCustomHostname(
  id: string,
  opts: ClientOpts = {},
): Promise<CloudflareHostname> {
  const config = opts.config ?? readCloudflareConfigOrNull();
  if (!config) throw new CloudflareError("Cloudflare is not configured.");
  const body = await cfFetch<CfHostnameRaw>(
    `/zones/${config.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    { method: "GET" },
    opts,
  );
  return normalize(body.result);
}

/** Delete a custom hostname. Returns true on success. */
export async function deleteCustomHostname(
  id: string,
  opts: ClientOpts = {},
): Promise<boolean> {
  const config = opts.config ?? readCloudflareConfigOrNull();
  if (!config) throw new CloudflareError("Cloudflare is not configured.");
  await cfFetch<unknown>(
    `/zones/${config.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    opts,
  );
  return true;
}
