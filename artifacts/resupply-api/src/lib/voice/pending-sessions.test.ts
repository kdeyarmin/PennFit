import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PendingSessions,
  InMemoryPendingSessionStore,
  __resetPendingSessionsForTests,
  getPendingSessions,
} from "./pending-sessions";

// These exercise the registry's contract against the in-memory store. The
// production store is Supabase-backed (shared across replicas, migration
// 0418) so the same contract holds regardless of which instance registers
// vs. claims a session.
describe("PendingSessions", () => {
  let registry: PendingSessions;
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    registry = new PendingSessions({
      ttlMs: 5_000,
      now: () => now,
      store: new InMemoryPendingSessionStore(),
    });
  });

  afterEach(() => {
    registry.shutdown();
  });

  it("registers an entry and returns it via peek without consuming", async () => {
    await registry.register({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
    });
    expect(await registry.peek("c1")).toMatchObject({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
      createdAt: 1_000_000,
      expiresAt: 1_005_000,
    });
    // Peek does not consume — second peek still hits.
    expect((await registry.peek("c1"))?.patientId).toBe("p1");
  });

  it("claim consumes the entry — second claim returns null", async () => {
    await registry.register({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
    });
    expect((await registry.claim("c1"))?.patientId).toBe("p1");
    // The whole point: a leaked conversationId rides exactly one WS upgrade.
    expect(await registry.claim("c1")).toBeNull();
  });

  it("peek and claim return null after TTL expiry", async () => {
    await registry.register({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
    });
    now += 5_000;
    // At exactly expiresAt the entry is swept (≤ comparison).
    expect(await registry.peek("c1")).toBeNull();
    expect(await registry.claim("c1")).toBeNull();
  });

  it("re-registering the same conversationId overwrites (admin re-dials)", async () => {
    await registry.register({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
    });
    now += 1_000;
    await registry.register({
      conversationId: "c1",
      patientId: "p2",
      episodeId: "e2",
    });
    const entry = await registry.claim("c1");
    expect(entry?.patientId).toBe("p2");
    expect(entry?.episodeId).toBe("e2");
    // The second register reset the TTL clock — the new expiresAt is
    // 1_001_000 + 5_000 = 1_006_000 (not 1_005_000).
    expect(entry?.expiresAt).toBe(1_006_000);
  });

  it("attachCallSid stamps the Twilio CallSid on a live entry", async () => {
    await registry.register({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
    });
    expect(await registry.attachCallSid("c1", "CA123")).toBe(true);
    expect((await registry.peek("c1"))?.twilioCallSid).toBe("CA123");
  });

  it("attachCallSid returns false for unknown conversation", async () => {
    expect(await registry.attachCallSid("never-registered", "CA123")).toBe(
      false,
    );
  });

  it("size reflects post-sweep count", async () => {
    await registry.register({
      conversationId: "c1",
      patientId: "p1",
      episodeId: "e1",
    });
    await registry.register({
      conversationId: "c2",
      patientId: "p2",
      episodeId: "e2",
    });
    expect(await registry.size()).toBe(2);
    now += 5_000; // both expire
    expect(await registry.size()).toBe(0);
  });

  it("singleton accessor returns the same instance across calls", () => {
    __resetPendingSessionsForTests();
    const a = getPendingSessions();
    const b = getPendingSessions();
    expect(a).toBe(b);
    __resetPendingSessionsForTests();
    const c = getPendingSessions();
    expect(c).not.toBe(a);
    __resetPendingSessionsForTests();
  });
});
