// Guardrails on the demo dataset.
//
// The demo tenant lives in the SAME database as real tenants and is swept
// by the same recurring workers. These tests pin the properties that keep
// that safe, so a later edit to the dataset can't quietly turn a demo row
// into an outbound message to a stranger.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEMO_SLUG,
  DEMO_UUID_PREFIX,
  id,
  namespaceId,
  PATIENTS,
  PROVIDERS,
  slugDiscriminator,
  THREADS,
} from "./demo-tenant-data";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("demo dataset — nothing can reach a real person", () => {
  // +1 (XXX) 555-01XX is reserved for fiction, so a misrouted SMS or voice
  // call cannot land on a real handset.
  it("uses only 555-01XX fictional phone numbers", () => {
    for (const p of PATIENTS) {
      expect(p.phone, `${p.first} ${p.last}`).toMatch(/^\+1\d{3}55501\d{2}$/);
    }
    for (const p of PROVIDERS) {
      expect(p.phone, p.legalName).toMatch(/^\+1\d{3}55501\d{2}$/);
      expect(p.fax, p.legalName).toMatch(/^\+1\d{3}55501\d{2}$/);
    }
  });

  // example.com is reserved by RFC 2606 and can never be registered, so a
  // stray email cannot be delivered to anybody.
  it("uses only example.com email addresses", () => {
    for (const p of PATIENTS) {
      expect(p.email, `${p.first} ${p.last}`).toMatch(/@example\.com$/);
    }
    for (const p of PROVIDERS) {
      expect(p.email, p.legalName).toMatch(/@example\.com$/);
    }
  });

  // Real NPPES numbers begin with 1 or 2. The 999… block cannot collide
  // with a live provider — which matters because resupply.providers is a
  // GLOBAL directory with no org_id, so these rows are visible tenant-wide.
  it("uses synthetic NPIs that cannot collide with real ones", () => {
    for (const p of PROVIDERS) {
      expect(p.npi, p.legalName).toMatch(/^999\d{7}$/);
    }
    expect(new Set(PROVIDERS.map((p) => p.npi)).size).toBe(PROVIDERS.length);
  });
});

describe("demo dataset — the reminder worker stays quiet", () => {
  // reminders.ts: an episode is only in the outreach funnel while its
  // status is one of these. Everything else is skipped by the scan.
  const IN_FUNNEL = new Set(["outreach_pending", "awaiting_response"]);

  // Eligibility is `daysBetween(lastFulfilled ?? rxCreated, now) >=
  // cadenceDays`. Every seeded patient has a fulfillment, so the baseline
  // is `lastFulfilledDaysAgo`. If that ever reaches the cadence for an
  // in-funnel episode, the next worker tick WILL try to send.
  it("leaves no in-funnel patient anywhere near due", () => {
    const inFunnel = PATIENTS.filter((p) => IN_FUNNEL.has(p.episodeStatus));
    expect(inFunnel.length).toBeGreaterThan(0); // the funnel must be demoable

    for (const p of inFunnel) {
      expect(
        p.lastFulfilledDaysAgo,
        `${p.first} ${p.last} is ${p.lastFulfilledDaysAgo}d past a ${p.cadenceDays}d cadence`,
      ).toBeLessThan(p.cadenceDays);
    }
  });

  // Half a cadence of headroom means the tenant can sit un-reseeded for
  // weeks without drifting into a send.
  it("keeps a wide margin, not a hairline one", () => {
    for (const p of PATIENTS.filter((x) => IN_FUNNEL.has(x.episodeStatus))) {
      expect(p.lastFulfilledDaysAgo).toBeLessThan(p.cadenceDays / 2);
    }
  });

  it("gives every patient a fulfillment baseline", () => {
    for (const p of PATIENTS) {
      expect(p.lastFulfilledDaysAgo).toBeGreaterThan(0);
    }
  });
});

describe("demo dataset — ids are stable and unique", () => {
  it("mints well-formed uuids under the demo prefix", () => {
    const sample = id("patient", 1);
    expect(sample).toMatch(UUID_RE);
    expect(sample.startsWith(`${DEMO_UUID_PREFIX}-`)).toBe(true);
  });

  it("never collides across kinds or rows", () => {
    const ids = [
      ...PROVIDERS.map((p) => id("provider", p.n)),
      ...PATIENTS.flatMap((p) => [
        id("patient", p.n),
        id("rx", p.n),
        id("episode", p.n),
        id("coverage", p.n),
        id("equipment", p.n),
        id("fulfillment", p.n),
        id("note", p.n),
      ]),
      ...THREADS.map((t) => id("conversation", t.n)),
      // Thread number is packed into the high byte so thread 2's message 1
      // cannot collide with thread 1's message 1.
      ...THREADS.flatMap((t) =>
        t.messages.map((m) => id("message", t.n * 100 + m.n)),
      ),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of ids) expect(v).toMatch(UUID_RE);
  });

  it("assigns each patient and provider a distinct number", () => {
    expect(new Set(PATIENTS.map((p) => p.n)).size).toBe(PATIENTS.length);
    expect(new Set(PROVIDERS.map((p) => p.n)).size).toBe(PROVIDERS.length);
  });
});

describe("demo dataset — referential integrity", () => {
  it("points every patient at a provider that exists", () => {
    const known = new Set(PROVIDERS.map((p) => p.n));
    for (const p of PATIENTS) {
      expect(known.has(p.providerN), `${p.first} ${p.last}`).toBe(true);
    }
  });

  it("hangs every inbox thread off a patient that exists", () => {
    const known = new Set(PATIENTS.map((p) => p.n));
    for (const t of THREADS) {
      expect(known.has(t.patientN), `thread ${t.n}`).toBe(true);
      expect(t.messages.length).toBeGreaterThan(0);
    }
  });

  // messages_body_max_length caps the column at 10k characters.
  it("keeps message bodies inside the column limit", () => {
    for (const t of THREADS) {
      for (const m of t.messages) {
        expect(m.body.length).toBeGreaterThan(0);
        expect(m.body.length).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

describe("fixture ids are namespaced per tenant", () => {
  // Every write upserts on `id`. Without a per-tenant discriminator a
  // second `--org-slug` run UPDATES the first tenant's rows onto the new
  // org_id instead of inserting its own — one demo tenant silently
  // swallowing another's patients, prescriptions and episodes.
  it("gives two tenants disjoint id sets", () => {
    const a = PATIENTS.map((p) => namespaceId(id("patient", p.n), "demo"));
    const b = PATIENTS.map((p) => namespaceId(id("patient", p.n), "demo-eu"));
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
  });

  // The tenant already seeded under the default slug must keep byte-identical
  // ids, or a re-seed inserts duplicates instead of updating in place.
  it("leaves the default slug's ids exactly as they were", () => {
    expect(slugDiscriminator(DEFAULT_DEMO_SLUG)).toBe("000");
    for (const p of PATIENTS) {
      const raw = id("patient", p.n);
      expect(namespaceId(raw, DEFAULT_DEMO_SLUG)).toBe(raw);
      expect(raw).toContain(`${DEMO_UUID_PREFIX}-0002-4000-8000-`);
    }
  });

  it("keeps the v4 UUID shape for any slug", () => {
    for (const slug of ["demo", "demo-eu", "acme", "x", "a-very-long-slug-2"]) {
      expect(namespaceId(id("episode", 7), slug)).toMatch(UUID_RE);
    }
  });

  it("never collides a non-default slug with the default", () => {
    for (const slug of ["demo-eu", "acme", "x", "training", "sales-2"]) {
      expect(slugDiscriminator(slug)).not.toBe("000");
    }
  });

  it("is stable and idempotent", () => {
    const once = namespaceId(id("rx", 3), "demo-eu");
    expect(namespaceId(once, "demo-eu")).toBe(once);
    expect(namespaceId(id("rx", 3), "demo-eu")).toBe(once);
  });

  // Applied to every string value at the sink, so it must not corrupt the
  // non-id fields (names, phone numbers, bodies) travelling alongside.
  it("leaves anything that is not a demo id untouched", () => {
    for (const v of [
      "Ellery Nakamura",
      "+12155550117",
      "",
      "0dec0de0",
      "11111111-2222-4333-8444-555555555555",
      "not-a-uuid-at-all",
    ]) {
      expect(namespaceId(v, "demo-eu")).toBe(v);
    }
  });

  // Distinct row kinds must stay distinct after re-keying — the
  // discriminator lives in a different UUID group than the kind.
  it("keeps different row kinds distinct", () => {
    const kinds = ["patient", "rx", "episode", "coverage"] as const;
    const ids = kinds.map((k) => namespaceId(id(k, 1), "demo-eu"));
    expect(new Set(ids).size).toBe(kinds.length);
  });
});
