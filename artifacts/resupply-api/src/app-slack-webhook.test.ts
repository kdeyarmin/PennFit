// Integration tests for the public Slack webhook routes, exercised through the
// REAL app so the raw-body ordering (app.ts express.raw for /resupply-api/slack
// BEFORE the global express.json()) and the tenant-routing / signature posture
// can't silently regress. Sibling of app-webhook-raw-body-ordering.test.ts.
//
// We mock only: the team_id→org resolver (deterministic tenant routing), the
// env resolver (so a signing secret is present), and verifySlackSignature
// (to flip valid/invalid and to capture the raw bytes it received). Everything
// else — the app, the routes, readSlackSigningSecretOrNull — stays real. No
// real DB is reached: the slash handler's queue lookup fails soft to a 200.

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // app.ts needs these at import time; nothing connects at construction.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  process.env.SUPABASE_URL =
    process.env.SUPABASE_URL ?? "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "test-service-role-key";
});

const captured = vi.hoisted(() => ({ rawBody: null as string | null }));
const sig = vi.hoisted(() => ({ valid: false }));

// Deterministic tenant routing: only "T_KNOWN" maps to a tenant.
vi.mock("./lib/slack/team-resolver", () => ({
  resolveOrgIdBySlackTeamId: vi.fn(async (teamId: string) =>
    teamId === "T_KNOWN" ? "org-test" : null,
  ),
}));

// Interactivity flag on (avoids a DB round-trip in the happy-path test);
// keep the other feature-flag exports real for the app's import graph.
vi.mock("./lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFeatureEnabled: vi.fn(async () => true),
}));

// Make a platform signing secret available (so resolution reaches verify),
// keeping every other store export real for the app's import graph.
vi.mock("./lib/app-config/store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEffectiveEnvForOrg: vi.fn(async () => ({
    SLACK_SIGNING_SECRET: "test-secret",
  })),
  getEffectiveEnv: vi.fn(async () => ({ SLACK_SIGNING_SECRET: "test-secret" })),
}));

// Control signature verification + capture the raw body it received (proves
// express.raw delivered the unparsed bytes, not a parsed object).
vi.mock("@workspace/resupply-integrations-slack", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    verifySlackSignature: (input: { rawBody: string | Buffer }) => {
      captured.rawBody =
        typeof input.rawBody === "string"
          ? input.rawBody
          : input.rawBody.toString("utf8");
      return sig.valid;
    },
  };
});

const { default: app } = await import("./app");

describe("Slack webhook routes", () => {
  it("503s when a present team_id maps to no tenant (no seed fallback)", async () => {
    await request(app)
      .post("/resupply-api/slack/commands")
      .set("content-type", "application/x-www-form-urlencoded")
      .send("team_id=T_UNKNOWN&text=queue")
      .expect(503);
  });

  it("401s on a bad signature, after receiving the raw body bytes", async () => {
    sig.valid = false;
    const payload = "team_id=T_KNOWN&text=queue";
    await request(app)
      .post("/resupply-api/slack/commands")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(payload)
      .expect(401);
    // Raw-body ordering: verify saw the exact unparsed bytes.
    expect(captured.rawBody).toBe(payload);
  });

  it("ACKs 200 for a valid signed interactivity request", async () => {
    sig.valid = true;
    // A "noop" action_id we don't handle: the route still authenticates,
    // passes the flag gate, and ACKs 200 immediately (the action dispatch is
    // fire-and-forget after the response), so no DB is awaited inline.
    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: "T_KNOWN" },
      user: { id: "U1" },
      actions: [{ action_id: "noop", value: "x" }],
    });
    await request(app)
      .post("/resupply-api/slack/interactivity")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(`payload=${encodeURIComponent(payload)}`)
      .expect(200);
    // Raw-body ordering held on the interactivity path too.
    expect(captured.rawBody).toContain("payload=");
  });
});
