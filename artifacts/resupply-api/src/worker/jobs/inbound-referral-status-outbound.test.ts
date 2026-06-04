// Regression guard (structural source check): the atomic-lease UPDATE in
// the inbound-referral status-outbound dispatcher MUST guard on
// `next_attempt_at <= nowIso` in addition to `status = 'queued'`.
//
// The claim deliberately leaves status='queued' (so a worker crash leaves
// the row recoverable) and only bumps next_attempt_at into the future.
// With the status guard ALONE, two overlapping ticks both match the same
// rows in their UPDATE WHERE and both get them back in RETURNING → the
// partner callback (accept / ship / PA-decision) is POSTed twice. The
// `next_attempt_at <= nowIso` guard makes the first tick's future-dated
// lease bump fail the second tick's re-evaluated WHERE, so exactly one
// tick wins each row (mirrors webhook-dispatcher.ts). A behavioural
// concurrency test would need a live Postgres; pin the guard cheaply,
// like the IDOR / dedup source checks elsewhere in this tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "inbound-referral-status-outbound.ts",
  ),
  "utf8",
);

describe("inbound-referral status-outbound — claim exclusivity guard", () => {
  it("re-checks next_attempt_at on the lease UPDATE (not status alone)", () => {
    // The lease UPDATE bumps next_attempt_at to leaseUntil; the same
    // predicate must appear AFTER that update so a concurrent tick's
    // re-evaluated WHERE fails and can't double-claim the row.
    const claimIdx = SRC.indexOf(".update({ next_attempt_at: leaseUntil");
    expect(claimIdx).toBeGreaterThan(-1);
    const guardIdx = SRC.indexOf('.lte("next_attempt_at", nowIso)', claimIdx);
    expect(guardIdx).toBeGreaterThan(claimIdx);
  });
});
