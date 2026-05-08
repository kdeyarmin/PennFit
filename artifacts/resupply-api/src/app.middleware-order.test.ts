// Static source-level guard for the Stripe webhook body-parser
// ordering contract.
//
// Stripe's webhook signature is computed over the exact bytes of the
// request body. If `express.json()` runs before the webhook route, it
// re-parses the body into an object that we cannot reserialize
// byte-identically — every signature verification then fails silently
// (Stripe retries seven times, then drops the event) and PHI / payment
// state silently goes stale.
//
// This test reads the source of `app.ts` and asserts:
//   1. The Stripe webhook route declares `express.raw(...)` as its
//      body parser.
//   2. That declaration appears textually BEFORE the global
//      `app.use(express.json(...))` mount.
//
// A unit test that boots the app and POSTs a fake event would be more
// precise, but it'd also require a live DB pool, configured Stripe
// keys, and the auth router's required env. The static check catches
// the only real-world regression we care about (someone reorders the
// middleware stack) without those dependencies.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "app.ts"), "utf8");

// Strip line and block comments so a stray `express.json()` mention
// in a doc-comment doesn't move the "first occurrence" position used
// by the ordering check below.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("app.ts middleware ordering", () => {
  it("mounts express.raw on the Stripe webhook BEFORE express.json", () => {
    const code = stripComments(APP_SOURCE);

    const stripeWebhookIdx = code.indexOf('"/resupply-api/stripe/webhook"');
    // Match only the real `express.json(...)` global mount, not any
    // documentation reference. The global mount lives inside an
    // `app.use(...)` call, so we anchor the search there.
    const jsonMountMatch = code.match(/app\.use\(\s*express\.json\(/);
    const rawCallMatch = code.match(/express\.raw\(/);

    expect(stripeWebhookIdx).toBeGreaterThan(-1);
    expect(rawCallMatch?.index).toBeDefined();
    expect(jsonMountMatch?.index).toBeDefined();

    const expressRawIdx = rawCallMatch!.index!;
    const expressJsonIdx = jsonMountMatch!.index!;

    // The raw body parser must precede the JSON parser in source order
    // so its registration on the webhook route runs first at request
    // time. Otherwise a JSON body posted to the webhook would be
    // parsed and Stripe signature verification would fail.
    expect(expressRawIdx).toBeLessThan(expressJsonIdx);
    // The raw parser must be co-located with the webhook route mount
    // (no other app.use() call slips between the route literal and
    // its parser declaration).
    const between = code.slice(stripeWebhookIdx, expressRawIdx);
    const otherMountBetween = /app\.use\(/.test(between);
    expect(otherMountBetween).toBe(false);
  });

  it("registers the Stripe webhook handler with express.raw, not express.json", () => {
    // Match the explicit raw() call between the webhook route literal
    // and the next handler to make the contract impossible to miss in
    // code review.
    const webhookBlock = APP_SOURCE.match(
      /app\.post\(\s*"\/resupply-api\/stripe\/webhook"\s*,[\s\S]*?stripeWebhookHandler/,
    );
    expect(webhookBlock).not.toBeNull();
    expect(webhookBlock?.[0]).toContain("express.raw(");
    expect(webhookBlock?.[0]).not.toContain("express.json(");
  });
});
