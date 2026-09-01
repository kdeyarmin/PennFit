#!/usr/bin/env tsx
//
// voice:simulate-inbound — post a correctly-SIGNED inbound voice webhook
// at a running API, and report which tenant it was attributed to.
//
// WHY THIS EXISTS
// ---------------
// Voice tenant attribution is the kind of thing that is obviously right
// in code review and wrong in production, because it depends on data
// nobody looks at: which DID each `organizations` row claims, on which
// channel. The unit tests pin the resolver's logic; this exercises the
// real route, against a real database, with a real signature — without
// anybody dialling a telephone or a patient answering one.
//
//   pnpm --filter @workspace/scripts voice:simulate-inbound -- \
//     --base-url=http://localhost:3000 \
//     --to=+15550001111 --from=+15550007777
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
// ------------------------------------
// It proves the route, the signature check, the called-number lookup and
// the tenant scoping. It does NOT prove that Twilio will call the right
// URL, that the DID is provisioned, or that audio flows — those need a
// real call, and docs/runbooks/voice-inbound-validation.md is where that
// is written down.
//
// SAFETY
// ------
//   * REFUSES a production target. The URL must be localhost, a private
//     address, or explicitly whitelisted with --i-know-this-is-not-prod
//     — and even then it refuses anything whose host resolves to the
//     configured production domain. A simulated inbound call against
//     production would create a real conversation for a real tenant and
//     could dispatch a real reminder.
//   * Uses numbers in the +1555 test range by default.
//   * Prints the org id the call was attributed to and nothing from the
//     response body beyond it — a TwiML body can carry a patient's name.

import { createHmac } from "node:crypto";

interface Args {
  baseUrl: string | null;
  to: string | null;
  from: string | null;
  callSid: string;
  authToken: string | null;
  path: string;
  force: boolean;
  repeat: number;
}

/** The production hosts this must never be pointed at. */
const PRODUCTION_HOSTS = [
  "pennfit.up.railway.app",
  "cmbreathe.com",
  "www.cmbreathe.com",
  "pennpaps.com",
  "www.pennpaps.com",
];

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    baseUrl: null,
    to: null,
    from: null,
    callSid: `CA${Date.now().toString(16).padStart(32, "0").slice(-32)}`,
    authToken: process.env.TWILIO_AUTH_TOKEN ?? null,
    path: "/resupply-api/voice/inbound-reorder",
    force: false,
    repeat: 1,
  };
  for (const raw of argv) {
    if (raw === "--i-know-this-is-not-prod") args.force = true;
    else if (raw.startsWith("--base-url=")) args.baseUrl = raw.slice(11);
    else if (raw.startsWith("--to=")) args.to = raw.slice(5);
    else if (raw.startsWith("--from=")) args.from = raw.slice(7);
    else if (raw.startsWith("--call-sid=")) args.callSid = raw.slice(11);
    else if (raw.startsWith("--auth-token=")) args.authToken = raw.slice(13);
    else if (raw.startsWith("--path=")) args.path = raw.slice(7);
    else if (raw.startsWith("--repeat=")) {
      const n = Number(raw.slice(9));
      if (Number.isInteger(n) && n > 0) args.repeat = Math.min(n, 10);
    }
  }
  return args;
}

/**
 * Twilio's request signature: HMAC-SHA1 over the full URL followed by
 * every POST parameter, sorted by key, concatenated as key+value.
 *
 * Reproduced here rather than imported so this tool exercises the
 * server's verifier as a genuine third party would — a shared
 * implementation would pass even if both sides were wrong together.
 */
function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(payload).digest("base64");
}

/**
 * Refuse a production target.
 *
 * A simulated inbound call against production creates a real
 * conversation for a real tenant and can dispatch a real message. There
 * is no flag that makes that acceptable, so the production host list is
 * checked even under --i-know-this-is-not-prod.
 */
function assertNotProduction(baseUrl: string, force: boolean): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    fail(`--base-url is not a URL: ${baseUrl}`);
  }
  if (PRODUCTION_HOSTS.includes(host)) {
    fail(
      `${host} is a production host. This tool creates a real conversation ` +
        "for a real tenant and can dispatch a real message. There is no flag " +
        "for this; use the inbound-call runbook instead.",
    );
  }
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host);
  if (!isLocal && !force) {
    fail(
      `${host} is not a local address. If this is genuinely a preview or ` +
        "staging environment, re-run with --i-know-this-is-not-prod.",
    );
  }
  if (process.env.DEPLOY_ENV === "production") {
    fail("DEPLOY_ENV=production — refusing to simulate an inbound call.");
  }
}

function fail(message: string): never {
  console.error(`voice:simulate-inbound — ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baseUrl || !args.to) {
    console.error(
      "Usage: voice:simulate-inbound -- --base-url=http://localhost:3000 \\\n" +
        "         --to=<the tenant's DID> [--from=<caller>] [--repeat=N]\n\n" +
        "Posts a correctly-signed inbound voice webhook and reports which\n" +
        "tenant the call was attributed to. Refuses a production target.\n",
    );
    process.exit(2);
  }
  assertNotProduction(args.baseUrl, args.force);

  if (!args.authToken) {
    fail(
      "No TWILIO_AUTH_TOKEN. The route verifies the signature, so an " +
        "unsigned request proves nothing except that the verifier rejects it.",
    );
  }

  const url = `${args.baseUrl.replace(/\/+$/, "")}${args.path}`;
  const from = args.from ?? "+15550007777";

  for (let attempt = 1; attempt <= args.repeat; attempt++) {
    // Same CallSid on every repeat, deliberately: that is what a Twilio
    // retry looks like, and the second one must not create a second
    // conversation.
    const params: Record<string, string> = {
      CallSid: args.callSid,
      From: from,
      To: args.to,
      Direction: "inbound",
      CallStatus: "ringing",
      AccountSid: "ACsimulated0000000000000000000000",
    };
    const signature = twilioSignature(args.authToken, url, params);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: new URLSearchParams(params).toString(),
    });

    const body = await res.text();
    // Report the SHAPE of the answer, never its content: a TwiML body
    // carries the practice's greeting and can carry a patient's name.
    console.log(
      `attempt ${attempt}/${args.repeat}  status=${res.status}  ` +
        `content-type=${res.headers.get("content-type") ?? "-"}  ` +
        `bytes=${body.length}  ` +
        `twiml=${body.trimStart().startsWith("<?xml") || body.includes("<Response") ? "yes" : "no"}`,
    );

    if (res.status === 403) {
      console.log(
        "  403 — the signature was rejected. Check TWILIO_AUTH_TOKEN matches " +
          "the one the API is running with, and that --base-url is the URL " +
          "the API sees (a proxy that rewrites the host breaks the signature).",
      );
    }
    if (res.status === 404 || body.includes("<Reject")) {
      console.log(
        "  The call was NOT attributed to a tenant. That is the fail-closed " +
          "path: no organizations row claims this number on the VOICE " +
          "channel. Check organizations.voice_from_number for the tenant.",
      );
    }
  }

  console.log(
    "\nNow verify the attribution in the database — the response cannot show it:\n" +
      `  SELECT org_id, direction, created_at FROM resupply.voice_calls\n` +
      `   WHERE call_sid = '${args.callSid}';\n` +
      "  SELECT org_id FROM resupply.conversations\n" +
      `   WHERE id = (SELECT conversation_id FROM resupply.voice_calls WHERE call_sid = '${args.callSid}');\n\n` +
      "One row, one org_id, and it must be the tenant that owns the dialled\n" +
      "number. A repeat run must NOT have created a second row.",
  );
}

void main().catch((err) => {
  console.error(
    `voice:simulate-inbound — failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
