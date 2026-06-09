import { describe, it, expect } from "vitest";

import {
  GENESIS_HASH,
  canonicalizeEventCore,
  computeEventHash,
  verifySignatureChain,
  type ChainEvent,
  type SignatureEventCore,
} from "./signature-events";

function core(overrides: Partial<SignatureEventCore> = {}): SignatureEventCore {
  return {
    requestId: "req-1",
    seq: 1,
    eventType: "created",
    actorKind: "employee",
    actorEmail: "csr@pennpaps.com",
    payload: {},
    ip: null,
    userAgent: null,
    occurredAt: "2026-06-09T12:00:00.000Z",
    ...overrides,
  };
}

/** Build a valid chain of N events for chain-verification tests. */
function buildChain(n: number): ChainEvent[] {
  const events: ChainEvent[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const c = core({ seq: i, eventType: i === 1 ? "created" : "viewed" });
    const eventHash = computeEventHash(prev, c);
    events.push({ seq: i, prevHash: prev, eventHash, core: c });
    prev = eventHash;
  }
  return events;
}

describe("canonicalizeEventCore", () => {
  it("is stable regardless of payload key insertion order", () => {
    const a = canonicalizeEventCore(core({ payload: { b: 2, a: 1 } }));
    const b = canonicalizeEventCore(core({ payload: { a: 1, b: 2 } }));
    expect(a).toBe(b);
  });

  it("changes when a hashed field changes", () => {
    const a = canonicalizeEventCore(core({ eventType: "created" }));
    const b = canonicalizeEventCore(core({ eventType: "signed" }));
    expect(a).not.toBe(b);
  });
});

describe("computeEventHash", () => {
  it("produces a 64-char hex digest", () => {
    const h = computeEventHash(GENESIS_HASH, core());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the previous hash (chaining)", () => {
    const h1 = computeEventHash(GENESIS_HASH, core());
    const h2 = computeEventHash("a".repeat(64), core());
    expect(h1).not.toBe(h2);
  });

  it("is deterministic for identical inputs", () => {
    expect(computeEventHash(GENESIS_HASH, core())).toBe(
      computeEventHash(GENESIS_HASH, core()),
    );
  });
});

describe("verifySignatureChain", () => {
  it("accepts an intact chain", () => {
    expect(verifySignatureChain(buildChain(4))).toEqual({ ok: true });
  });

  it("accepts an empty chain", () => {
    expect(verifySignatureChain([])).toEqual({ ok: true });
  });

  it("verifies regardless of input ordering", () => {
    const chain = buildChain(3);
    const shuffled = [chain[2]!, chain[0]!, chain[1]!];
    expect(verifySignatureChain(shuffled)).toEqual({ ok: true });
  });

  it("rejects a tampered event body", () => {
    const chain = buildChain(3);
    // Mutate the core of the middle event without recomputing its hash.
    chain[1] = {
      ...chain[1]!,
      core: { ...chain[1]!.core, actorEmail: "attacker@evil.test" },
    };
    const result = verifySignatureChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAtSeq).toBe(2);
      expect(result.reason).toBe("event_hash_mismatch");
    }
  });

  it("rejects a broken prev-hash link (deleted event)", () => {
    const chain = buildChain(3);
    // Drop the middle event — seq 3's prevHash no longer matches seq 1.
    const result = verifySignatureChain([chain[0]!, chain[2]!]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAtSeq).toBe(3);
      expect(result.reason).toBe("prev_hash_mismatch");
    }
  });

  it("rejects a chain whose first event does not start at genesis", () => {
    const chain = buildChain(2);
    chain[0] = { ...chain[0]!, prevHash: "f".repeat(64) };
    const result = verifySignatureChain(chain);
    expect(result.ok).toBe(false);
  });
});
