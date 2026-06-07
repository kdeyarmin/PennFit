// verify:deploy — post-deploy smoke test for the public surface.
//
// Curls a running deployment from the OUTSIDE and asserts that the
// resupply-api routes are actually reachable — not silently answered
// by the SPA history-fallback. This catches the specific failure mode
// where the production domain is bound to a host that serves the
// (current) static SPA but has no live `resupply-api` process behind
// `/resupply-api/*`: the storefront loads, but every `fetch(...,
// {Accept: 'application/json'})` to the API returns a 404 (the SPA
// fallback declines JSON requests) and the shop page shows
// "Failed to load shop products (404)".
//
// Usage:
//   pnpm --filter @workspace/scripts verify:deploy -- https://pennfit.up.railway.app
//   node --import=tsx scripts/src/verify-deploy.ts https://pennfit.up.railway.app
//
// Base URL resolution (first match wins):
//   1. first CLI arg
//   2. $VERIFY_DEPLOY_URL
//   3. $RAILWAY_PUBLIC_DOMAIN (bare host — https:// is prepended)
//   4. https://pennfit.up.railway.app
//
// What it asserts:
//   * GET /resupply-api/healthz  (Accept: application/json)
//       → 200, JSON, body.status === "ok".  A 404 or an HTML body
//         means the API tree isn't mounted in the host answering this
//         domain.
//   * GET /resupply-api/shop/products  (Accept: application/json)
//       → 200, JSON, body.products is an array.  This is the exact
//         call the shop page makes.
//   * GET /  (Accept: text/html)
//       → 200, HTML.  Confirms the SPA shell is served (informational;
//         a non-200 here is a warning, not a hard failure, since the
//         API being reachable is what this script primarily guards).
//
// Exit codes:
//   0 — every required check passed.
//   1 — at least one required check failed.
//   2 — internal error (the checker itself crashed).

// Mark this file as a module so its top-level declarations stay
// file-scoped. Without this, TypeScript treats it (and the sibling
// preflight-prod-env.ts) as a global script and the shared helper
// names (`paint`, `record`, `report`, `main`, …) collide at compile
// time.
export {};

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const paint = (color: string, text: string): string =>
  useColor ? `${color}${text}${RESET}` : text;

type Severity = "pass" | "warn" | "fail";

interface CheckResult {
  severity: Severity;
  label: string;
  detail: string;
}

const results: CheckResult[] = [];
function record(severity: Severity, label: string, detail: string): void {
  results.push({ severity, label, detail });
}

function resolveBaseUrl(): string {
  // pnpm forwards a literal `--` separator as an argument in some
  // versions (`pnpm verify:deploy -- <url>`); skip it (and any empty
  // tokens) when picking the positional base-URL arg.
  const fromArg = process.argv
    .slice(2)
    .find((a) => a && a.trim() && a.trim() !== "--")
    ?.trim();
  const fromEnv = process.env["VERIFY_DEPLOY_URL"]?.trim();
  const fromRailway = process.env["RAILWAY_PUBLIC_DOMAIN"]?.trim();
  let raw =
    fromArg ||
    fromEnv ||
    (fromRailway ? `https://${fromRailway}` : "") ||
    "https://pennfit.up.railway.app";
  // Accept a bare host (e.g. RAILWAY_PUBLIC_DOMAIN) by prepending https.
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  // Trim a trailing slash so path concatenation is clean.
  return raw.replace(/\/+$/, "");
}

const TIMEOUT_MS = 15_000;

interface Probe {
  status: number;
  contentType: string;
  bodyText: string;
  json: unknown;
}

// `fetch` rejects with a generic `TypeError: fetch failed` whenever the
// connection can't be established — the actionable reason (ECONNREFUSED,
// ENOTFOUND, a connect timeout, an egress-policy block, …) lives in
// `err.cause`, not in `err.message`. Surface it so a connectivity/egress
// failure (e.g. running this probe from a sandbox whose network policy
// blocks the public host) isn't mistaken for a dead or unrouted API.
// undici nests its codes one level deeper inside an AggregateError's
// `.errors` when several candidate addresses were tried, so recurse.
function causeDetail(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  const nested = (value as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    for (const e of nested) {
      const found = causeDetail(e);
      if (found) return found;
    }
  }
  const message = (value as { message?: unknown }).message;
  if (typeof message === "string" && message) return message;
  return null;
}

function describeError(err: Error): string {
  const detail = causeDetail(err.cause);
  return detail ? `${err.message} (${detail})` : err.message;
}

async function probe(
  url: string,
  accept: string,
): Promise<Probe | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: accept },
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = res.headers.get("content-type") ?? "";
    const bodyText = await res.text();
    let json: unknown = undefined;
    if (contentType.includes("application/json")) {
      try {
        json = JSON.parse(bodyText);
      } catch {
        /* leave json undefined; the check below treats it as non-JSON */
      }
    }
    return { status: res.status, contentType, bodyText, json };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === "AbortError"
          ? `timeout after ${TIMEOUT_MS}ms`
          : describeError(err)
        : String(err);
    return { error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeHtml(p: Probe): boolean {
  return (
    p.contentType.includes("text/html") ||
    /^\s*<!doctype html/i.test(p.bodyText) ||
    /^\s*<html/i.test(p.bodyText)
  );
}

async function checkApiJson(
  base: string,
  path: string,
  validate: (json: Record<string, unknown>) => string | null,
): Promise<void> {
  const url = `${base}${path}`;
  const p = await probe(url, "application/json");
  if ("error" in p) {
    record("fail", path, `request failed: ${p.error}`);
    return;
  }
  if (p.status === 404) {
    record(
      "fail",
      path,
      "404 for a JSON request — the API tree is NOT mounted on this host. " +
        "The request was almost certainly answered by the SPA history-" +
        "fallback (which 404s JSON). Bind the production domain to the " +
        "single Express service (railway.json startCommand) so " +
        "/resupply-api/* is served by a live resupply-api process.",
    );
    return;
  }
  if (looksLikeHtml(p)) {
    record(
      "fail",
      path,
      `HTTP ${p.status} but the body is HTML (the SPA shell), not JSON — ` +
        "the API tree is not serving this path on this host.",
    );
    return;
  }
  if (p.status !== 200) {
    // 503 is a legitimate "dependency degraded" signal, not a routing
    // failure — surface it as a warning so the smoke test can still
    // distinguish "API reachable but degraded" from "API not routed".
    const sev: Severity = p.status === 503 ? "warn" : "fail";
    record(sev, path, `unexpected HTTP ${p.status}`);
    return;
  }
  if (p.json === undefined || typeof p.json !== "object" || p.json === null) {
    record("fail", path, "200 but body did not parse as a JSON object");
    return;
  }
  const problem = validate(p.json as Record<string, unknown>);
  if (problem) {
    record("fail", path, `200 JSON but ${problem}`);
    return;
  }
  record("pass", path, `200 JSON, reachable`);
}

async function checkSpaShell(base: string): Promise<void> {
  const p = await probe(`${base}/`, "text/html");
  if ("error" in p) {
    record("warn", "/", `request failed: ${p.error}`);
    return;
  }
  if (p.status === 200 && looksLikeHtml(p)) {
    record("pass", "/", "200 HTML (SPA shell served)");
  } else {
    record("warn", "/", `HTTP ${p.status}, content-type "${p.contentType}"`);
  }
}

function report(): number {
  const pass = results.filter((r) => r.severity === "pass").length;
  const warn = results.filter((r) => r.severity === "warn").length;
  const fail = results.filter((r) => r.severity === "fail").length;

  console.log("");
  for (const r of results) {
    const tag =
      r.severity === "pass"
        ? paint(GREEN, "PASS")
        : r.severity === "warn"
          ? paint(YELLOW, "WARN")
          : paint(RED, "FAIL");
    console.log(`  ${tag}  ${r.label}`);
    console.log(`        ${paint(DIM, r.detail)}`);
  }
  console.log("");
  console.log(
    `  ${paint(GREEN, `${pass} passed`)}, ` +
      `${paint(YELLOW, `${warn} warning(s)`)}, ` +
      `${paint(fail > 0 ? RED : DIM, `${fail} failed`)}`,
  );
  console.log("");
  return fail > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const base = resolveBaseUrl();
  console.log(`verify:deploy → ${paint(DIM, base)}`);

  // /healthz is the cheapest proof the API tree is mounted: it touches
  // no dependency and returns {status:"ok"}. If THIS 404s for a JSON
  // request, the API isn't behind this domain at all.
  await checkApiJson(base, "/resupply-api/healthz", (json) =>
    json["status"] === "ok"
      ? null
      : `status was ${JSON.stringify(json["status"])}`,
  );

  // The exact call the shop page makes. Reachability is what we assert;
  // an empty catalog (preview mode with no SKUs) is still a pass.
  await checkApiJson(base, "/resupply-api/shop/products", (json) =>
    Array.isArray(json["products"]) ? null : "body had no `products` array",
  );

  await checkSpaShell(base);

  return report();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(paint(RED, "verify:deploy crashed:"), err);
    process.exit(2);
  });
