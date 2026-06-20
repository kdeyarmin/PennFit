import { describe, it, expect } from "vitest";

import {
  aggregateReorderFunnel,
  type ReorderFunnelConversation,
  type ReorderFunnelEpisode,
} from "./reorder-funnel";

const episodes: ReorderFunnelEpisode[] = [
  { id: "e1", status: "fulfilled" }, // reminded(sms,email) confirmed shipped
  { id: "e2", status: "confirmed" }, // reminded(sms) confirmed, not shipped
  { id: "e3", status: "awaiting_response" }, // reminded(email), no confirm
  { id: "e4", status: "outreach_pending" }, // never reminded
  { id: "e5", status: "declined" }, // reminded(voice), declined
];

const conversations: ReorderFunnelConversation[] = [
  { episodeId: "e1", channel: "sms" },
  { episodeId: "e1", channel: "email" },
  { episodeId: "e2", channel: "sms" },
  { episodeId: "e3", channel: "email" },
  { episodeId: "e5", channel: "voice" },
  { episodeId: "e3", channel: "chat" }, // non-ladder channel → ignored
];

describe("aggregateReorderFunnel", () => {
  it("rolls up the due → reminded → confirmed → shipped funnel", () => {
    const r = aggregateReorderFunnel(episodes, conversations, new Set(["e1"]));
    expect(r.due).toBe(5);
    expect(r.reminded).toBe(4); // e1,e2,e3,e5 (e4 never reminded)
    expect(r.confirmed).toBe(2); // e1 fulfilled + e2 confirmed
    expect(r.shipped).toBe(1); // e1
  });

  it("breaks down conversion by channel (multi-channel episodes count in each)", () => {
    const r = aggregateReorderFunnel(episodes, conversations, new Set(["e1"]));
    // sms reached e1 + e2 → both confirmed; e1 shipped.
    expect(r.byChannel.sms).toEqual({ reminded: 2, confirmed: 2, shipped: 1 });
    // email reached e1 (confirmed+shipped) + e3 (not confirmed).
    expect(r.byChannel.email).toEqual({
      reminded: 2,
      confirmed: 1,
      shipped: 1,
    });
    // voice reached only e5 (declined).
    expect(r.byChannel.voice).toEqual({
      reminded: 1,
      confirmed: 0,
      shipped: 0,
    });
  });

  it("never counts an UNREMINDED episode in the confirmed/shipped stages", () => {
    // A reorder that confirmed AND shipped without any reminder must not leak
    // into the later stages — those measure reminder effectiveness, so they are
    // scoped to reminded episodes only. Without that, rates exceed 100% and the
    // top-line disagrees with the per-channel table.
    const eps: ReorderFunnelEpisode[] = [
      { id: "r1", status: "fulfilled" }, // reminded(sms), confirmed, shipped
      { id: "u1", status: "fulfilled" }, // NEVER reminded, but shipped
      { id: "u2", status: "confirmed" }, // NEVER reminded, but confirmed
    ];
    const convs: ReorderFunnelConversation[] = [
      { episodeId: "r1", channel: "sms" },
    ];
    const r = aggregateReorderFunnel(eps, convs, new Set(["r1", "u1"]));
    expect(r.due).toBe(3); // the whole window
    expect(r.reminded).toBe(1); // only r1
    expect(r.confirmed).toBe(1); // only r1 — u1/u2 excluded (never reminded)
    expect(r.shipped).toBe(1); // only r1 — u1 excluded
    // every stage stays nested: shipped ⊆ confirmed ⊆ reminded ⊆ due.
    expect(r.shipped).toBeLessThanOrEqual(r.confirmed);
    expect(r.confirmed).toBeLessThanOrEqual(r.reminded);
    expect(r.byChannel.sms).toEqual({ reminded: 1, confirmed: 1, shipped: 1 });
    expect(r.rates.confirmedOfReminded).toBe(1); // 1/1, not 3/1
  });

  it("computes stage-to-stage rates (null when the prior stage is empty)", () => {
    const r = aggregateReorderFunnel(episodes, conversations, new Set(["e1"]));
    expect(r.rates.remindedOfDue).toBe(0.8); // 4/5
    expect(r.rates.confirmedOfReminded).toBe(0.5); // 2/4
    expect(r.rates.shippedOfConfirmed).toBe(0.5); // 1/2

    const empty = aggregateReorderFunnel([], [], new Set());
    expect(empty.rates.remindedOfDue).toBeNull();
    expect(empty.due).toBe(0);
  });
});
