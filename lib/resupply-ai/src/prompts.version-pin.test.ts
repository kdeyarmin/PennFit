// Drift detector: pins the rendered system prompt to a hash keyed
// by PROMPT_VERSION.
//
// Why:
//   The audit log stamps PROMPT_VERSION on every voice call so we
//   can reconstruct what the model was told for any historical
//   conversation (HIPAA Tier-2 audit posture; a model that gave a
//   different answer than the doc-of-record blames the prompt the
//   audit row points at). If someone edits the prompt body without
//   bumping PROMPT_VERSION, every audit row from that point forward
//   names the OLD version against the NEW behaviour — silent drift
//   that surfaces only when someone tries to reproduce an old call.
//
// Mechanism:
//   1. Build the prompt with a canonical fixed input.
//   2. Strip the "Prompt version: X." line so the hash isn't
//      circular (otherwise bumping the version always passes).
//   3. SHA-256 the rest.
//   4. Look the current PROMPT_VERSION up in PROMPT_VERSION_HASHES.
//      Fail loudly if either (a) the version has no entry or
//      (b) the entry's hash differs from the actual.
//
// Updating after an INTENTIONAL prompt change:
//   1. Bump PROMPT_VERSION in prompts.ts.
//   2. Run this test once — it will print the new hash in the
//      failure message.
//   3. Add a new entry to PROMPT_VERSION_HASHES with the printed
//      hash. Keep older entries in place so historical audit-log
//      reproductions stay verifiable.
//
// If someone edits the prompt WITHOUT bumping the version this test
// fails on the current entry's hash — they have to either revert
// the edit OR bump the version + record the new hash.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildSystemPrompt, PROMPT_VERSION } from "./prompts";

/**
 * Canonical inputs used to render the prompt for hashing. Constants
 * (not real practice / agent names) so the rendered prompt is
 * deterministic regardless of which deploy this test runs in.
 */
const CANONICAL_INPUT = {
  practiceName: "CANON_PRACTICE",
  callerName: "CANON_AGENT",
  callContext: "CANON_CONTEXT",
} as const;

/**
 * Map each shipped PROMPT_VERSION to the SHA-256 of its rendered
 * prompt (with the trailing `Prompt version: …` line stripped).
 *
 * KEEP HISTORICAL ENTRIES — removing them defeats the audit-log
 * reproduction story this whole file exists to defend. When a new
 * version ships, ADD a new key; never edit an existing one.
 */
const PROMPT_VERSION_HASHES: Readonly<Record<string, string>> = {
  "2026-05-22.v2":
    "92ccc9744b4fa0354054ad636116d2cc2ae30b593fe20932421e9591d4f9b975",
  "2026-05-26.v3":
    "0391e79380bd79dc9455392f3e2dd3cd848d6869703d4b40031b3ea81136df27",
  "2026-06-08.v4":
    "d649f6de1b5dd50fae9e50b16ba5bc9a8173d10496debda1cd80fbb40215781d",
  "2026-06-09.v5":
    "536a15815b7ad1c3244d6d8b7c4561ddb7294de2f2bd1ec7dc2c2e76bccdfb27",
  // v6 adds the storefront (shop_customer) caller-kind variant. The
  // PATIENT render is unchanged, so this hash matches v5's; the shop
  // variant is pinned separately in SHOP_PROMPT_HASH below.
  "2026-06-09.v6":
    "536a15815b7ad1c3244d6d8b7c4561ddb7294de2f2bd1ec7dc2c2e76bccdfb27",
  // v7 strengthens the "How to speak" guidance (react before moving on,
  // vary openers, natural hesitations, one question at a time, use the
  // caller's first name, conversational list read-back) to make the agent
  // sound more human. The block is shared, so the shop variant hash below
  // changes too.
  "2026-06-09.v7":
    "0cb704a6d0cf881cad2fbf4290b868cbf128d6116d0c15eaa7fec7cee2705c92",
  // v8 adds personality guidance to the shared "How to speak" block —
  // small-talk handling, changing tactics after a repeated mishearing,
  // and warm call bookends. Shared block, so the shop variant hash moves
  // too.
  "2026-06-09.v8":
    "71961b3b5eab3baa82f406f93a6fcc5a012c231510af38e5f91adcec35e82529",
};

function renderCanonicalPrompt(): string {
  return buildSystemPrompt(CANONICAL_INPUT);
}

function hashStrippingVersionLine(prompt: string, version: string): string {
  // Replace the literal `Prompt version: <version>.` token with a
  // canonical placeholder so bumping the version (and ONLY bumping
  // the version) doesn't change the hash — otherwise the gate is
  // circular and never catches body drift. We DON'T slice off
  // everything after the version line: if a future edit lands new
  // content trailing the version stamp, that content must be hashed
  // too, or the detector becomes blind to it.
  const token = `Prompt version: ${version}.`;
  const stripped = prompt.split(token).join("Prompt version: <PINNED>.");
  return createHash("sha256").update(stripped).digest("hex");
}

/**
 * The storefront (shop_customer) variant renders different Scope / Identity
 * / Tools clauses. Pinned separately from PROMPT_VERSION_HASHES (which
 * tracks the patient render) so drift in the shop clauses is caught too.
 * Update the same way: render, take the printed hash, record it here.
 */
const SHOP_PROMPT_HASH =
  "e2d9c7ad6fe44263a5e4d7ee630f6a61a7d32d7b3f0ee05d1791c3d754356195";

describe("PROMPT_VERSION drift detector", () => {
  it("has a recorded hash for the currently-shipped PROMPT_VERSION", () => {
    expect(
      PROMPT_VERSION_HASHES,
      `PROMPT_VERSION "${PROMPT_VERSION}" has no recorded hash. ` +
        `When bumping the version, add a new entry to PROMPT_VERSION_HASHES ` +
        `with the value this test prints on failure.`,
    ).toHaveProperty(PROMPT_VERSION);
  });

  it("the rendered prompt hash matches the recorded hash for this version", () => {
    const actual = hashStrippingVersionLine(
      renderCanonicalPrompt(),
      PROMPT_VERSION,
    );
    const expected = PROMPT_VERSION_HASHES[PROMPT_VERSION];
    if (expected === undefined) {
      // The previous test already reported "no recorded hash" — skip
      // the comparison so we don't double-fail with a noisier message.
      return;
    }
    if (actual !== expected) {
      throw new Error(
        [
          "Prompt body drift detected.",
          `Expected hash for PROMPT_VERSION="${PROMPT_VERSION}": ${expected}`,
          `Actual hash:                                ${actual}`,
          "",
          "What this means:",
          "  Either someone edited the prompt body without bumping",
          "  PROMPT_VERSION, OR they bumped PROMPT_VERSION but forgot",
          "  to record the new hash in PROMPT_VERSION_HASHES.",
          "",
          "How to fix:",
          "  * If the prompt change was UNINTENDED — revert the edit.",
          "  * If the prompt change was INTENDED:",
          "      1. Bump PROMPT_VERSION in lib/resupply-ai/src/prompts.ts",
          "         (only if you haven't already — bumping it changes",
          "          the audit-log version stamp for future calls).",
          "      2. Add an entry to PROMPT_VERSION_HASHES in this file",
          "         keyed by the new PROMPT_VERSION, with the actual",
          "         hash above as the value. KEEP older entries.",
        ].join("\n"),
      );
    }
  });

  it("the shop_customer variant matches its recorded hash", () => {
    const actual = hashStrippingVersionLine(
      buildSystemPrompt({ ...CANONICAL_INPUT, callerKind: "shop_customer" }),
      PROMPT_VERSION,
    );
    if (actual !== SHOP_PROMPT_HASH) {
      throw new Error(
        `Shop prompt drift. Expected ${SHOP_PROMPT_HASH}, got ${actual}. ` +
          "If the change was intended, record the value above in SHOP_PROMPT_HASH.",
      );
    }
  });

  it("is deterministic — running the hash twice produces the same value", () => {
    const a = hashStrippingVersionLine(renderCanonicalPrompt(), PROMPT_VERSION);
    const b = hashStrippingVersionLine(renderCanonicalPrompt(), PROMPT_VERSION);
    expect(a).toBe(b);
  });

  it("hashing strips the trailing version line so version bumps alone don't change the hash", () => {
    // Compute a hash with the real version line, then a hash with a
    // fake version line, both rendered against the SAME prompt. Both
    // helper paths should produce the same hash because the strip is
    // the last thing they do.
    const prompt = renderCanonicalPrompt();
    const realHash = hashStrippingVersionLine(prompt, PROMPT_VERSION);
    const promptWithFakeVersion = prompt.replace(
      `Prompt version: ${PROMPT_VERSION}.`,
      `Prompt version: FAKE_VERSION_FOR_TEST.`,
    );
    const fakeHash = hashStrippingVersionLine(
      promptWithFakeVersion,
      "FAKE_VERSION_FOR_TEST",
    );
    expect(realHash).toBe(fakeHash);
  });
});
