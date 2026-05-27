// Integration test for the invite-password-expiry-notify sweep.
//
// The companion unit test (`invite-password-expiry-notify.test.ts`)
// runs against a hand-rolled Supabase mock and verifies the
// dispatcher logic in isolation. That mock can't catch:
//
//   * PostgREST filter typos (`.lt` vs `.lte`, swapped `is` argument);
//   * column-name drift between the SQL migration and the worker;
//   * off-by-one in the TTL / lead-time math; or
//   * re-invite handling that depends on a `set_by_admin_at` value
//     that's actually persisted by Postgres (timestamptz string
//     comparison vs. millisecond comparison).
//
// This suite seeds `resupply_auth.users` + `resupply_auth.password_credentials`
// rows at five distinct `set_by_admin_at` ages and runs the real
// sweep against a real Postgres + the real Supabase service-role
// client. The only thing mocked is SendGrid (`@workspace/resupply-email`)
// — we don't want a test run to hammer the SendGrid API or leak fake
// email addresses to a real sender.
//
// Skip-when-unconfigured contract: same env-var triad as
// `lib/resupply-audit/src/index.integration.test.ts`. When any of
// DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is missing
// we skip the whole suite so `pnpm -r test` stays green in CI lanes
// that don't have all three.
//
// Cleanup is surgical: every seeded row carries a per-run email
// prefix and we DELETE only those rows in afterAll. We never
// truncate the tables — other suites may be running in parallel.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// IMPORTANT: mock SendGrid BEFORE importing the worker module, so the
// dynamic `createSendgridClient` call inside the sweep resolves to
// our stub. We don't mock supabase here — the sweep must hit the
// real PostgREST surface for this suite to be meaningful.
const sendEmailMock = vi.fn(
  async (..._args: unknown[]) => undefined as unknown,
);
vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: () => ({ sendEmail: sendEmailMock }),
}));

import {
  __resetDbPoolForTests,
  getDbPool,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { ADMIN_PASSWORD_TTL_MS } from "@workspace/resupply-auth";

import { runInvitePasswordExpiryNotifySweep } from "./invite-password-expiry-notify";

const skip =
  !process.env.DATABASE_URL ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY;

const describeIfDb = skip ? describe.skip : describe;

const TTL_MS = 7 * 86_400_000;
const REMINDER_LEAD_MS = 2 * 86_400_000;
// Comfortable buffer either side of the TTL boundaries so a slow
// test runner doesn't make a "definitely expired" row look fresh
// and vice-versa.
const SAFE_MARGIN_MS = 6 * 3_600_000; // 6 hours

const FULL_CFG = {
  sendgridApiKey: "SG.integration-test",
  sendgridFromEmail: "info@pennpaps.example",
  sendgridFromName: "PennPaps",
  practiceName: "PennPaps",
  publicBaseUrl: "https://pennfit.example",
};

describeIfDb("invite-password-expiry-notify (live db)", () => {
  // Per-run prefix tags every email we seed so cleanup is surgical
  // and parallel test runs don't trip over each other.
  const runTag = `expiry-notify-it-${Math.random().toString(36).slice(2, 10)}`;
  const emailFor = (slot: string) => `${runTag}+${slot}@example.test`;

  const userIdBySlot = new Map<string, string>();
  // Set in beforeAll once we've confirmed the auth migrations are
  // present on this DATABASE_URL. If false, every test in the suite
  // bails out via ctx.skip() — this is the "DATABASE_URL is set but
  // points at a database without our migrations applied" case (e.g.
  // a workspace whose pg instance hasn't been migrated yet). The
  // suite stays opt-in: it runs full when migrations are present,
  // skips cleanly otherwise.
  let migrationsReady = false;

  /** Insert a (user, password_credentials) pair via raw SQL. We use
   *  the pg pool directly so the test setup is independent of the
   *  PostgREST surface we're trying to exercise — a typo in our
   *  seeding code shouldn't masquerade as a sweep bug. */
  async function seed(
    slot: string,
    opts: {
      ageMs: number;
      mustChange?: boolean;
      reminderStampOffsetMs?: number | null;
      expiredStampOffsetMs?: number | null;
      status?: "invited" | "active" | "revoked";
    },
  ): Promise<string> {
    const pool = getDbPool();
    const now = Date.now();
    const setByAdminAt = new Date(now - opts.ageMs).toISOString();
    const reminderStamp =
      opts.reminderStampOffsetMs === undefined ||
      opts.reminderStampOffsetMs === null
        ? null
        : new Date(now - opts.ageMs + opts.reminderStampOffsetMs).toISOString();
    const expiredStamp =
      opts.expiredStampOffsetMs === undefined ||
      opts.expiredStampOffsetMs === null
        ? null
        : new Date(now - opts.ageMs + opts.expiredStampOffsetMs).toISOString();

    const userIns = await pool.query<{ id: string }>(
      `INSERT INTO resupply_auth.users (email_lower, display_name, role, status)
       VALUES ($1, $2, 'agent', $3) RETURNING id`,
      [emailFor(slot), `Test ${slot}`, opts.status ?? "invited"],
    );
    const userId = userIns.rows[0].id;
    await pool.query(
      `INSERT INTO resupply_auth.password_credentials
         (user_id, password_hash, algo, must_change, set_by_admin_at,
          expiry_reminder_sent_at, expired_notice_sent_at)
       VALUES ($1, $2, 'argon2id-v1', $3, $4, $5, $6)`,
      [
        userId,
        "$argon2id$v=19$m=1,t=1,p=1$AAAA$AAAA", // placeholder; sweep never reads it
        opts.mustChange ?? true,
        setByAdminAt,
        reminderStamp,
        expiredStamp,
      ],
    );
    userIdBySlot.set(slot, userId);
    return userId;
  }

  beforeAll(async () => {
    // Sanity: our seed() age targets are anchored on TTL_MS. If the
    // worker's runtime constant ever drifts away from 7d, the seeded
    // rows would no longer land in the intended windows and the
    // failure mode would be a confusing assertion mismatch rather
    // than a clear "TTL changed" signal. Compare against the actual
    // exported constant so the drift is caught here.
    expect(ADMIN_PASSWORD_TTL_MS).toBe(TTL_MS);

    // Probe for the auth migrations, specifically the 0143 stamp
    // columns. Selecting both columns by name fails fast (and we
    // skip the suite) when either the schema, the table, or the
    // 0143 migration is absent — instead of dumping a confusing
    // "relation/column does not exist" at insert time.
    try {
      await getDbPool().query(
        `SELECT expiry_reminder_sent_at, expired_notice_sent_at
           FROM resupply_auth.password_credentials LIMIT 0`,
      );
      migrationsReady = true;
    } catch {
      migrationsReady = false;
    }
  });

  beforeEach(() => {
    sendEmailMock.mockClear();
  });

  afterAll(async () => {
    // Cleanup: cascade from users → password_credentials via the
    // ON DELETE CASCADE in the migration. Match by our run-tag
    // email prefix so we never touch anyone else's data. Skip
    // entirely if the migrations weren't there — nothing to clean.
    if (migrationsReady) {
      const pool = getDbPool();
      await pool.query(
        `DELETE FROM resupply_auth.users WHERE email_lower LIKE $1`,
        [`${runTag}+%`],
      );
    }
    await __resetDbPoolForTests();
  });

  it("stamps and emails the right rows across every age window", async (ctx) => {
    if (!migrationsReady) {
      ctx.skip();
      return;
    }
    // Five slots covering every branch of the sweep:
    //   young    — age 1d → no reminder due, no expiry
    //   reminder — age 6d → reminder window (TTL-LEAD < age < TTL)
    //   expired  — age 8d → past TTL, expired-notice due
    //   stale    — age 6d, prior-invite reminder stamped 30d ago
    //              (predates set_by_admin_at) → fresh reminder due
    //   claimed  — age 6d, reminder stamped 1h after set_by_admin_at
    //              → already-claimed, no email
    await seed("young", {
      ageMs: 1 * 86_400_000,
    });
    await seed("reminder", {
      ageMs: TTL_MS - REMINDER_LEAD_MS - SAFE_MARGIN_MS,
    });
    await seed("expired", {
      ageMs: TTL_MS + SAFE_MARGIN_MS,
    });
    await seed("stale", {
      ageMs: TTL_MS - REMINDER_LEAD_MS - SAFE_MARGIN_MS,
      // Stamp recorded 30 days BEFORE set_by_admin_at — i.e. from a
      // previous invite the same row was reused for. The sweep
      // should treat this as stale and re-send.
      reminderStampOffsetMs: -30 * 86_400_000,
    });
    await seed("claimed", {
      ageMs: TTL_MS - REMINDER_LEAD_MS - SAFE_MARGIN_MS,
      // Stamp recorded 1 hour AFTER set_by_admin_at — i.e. already
      // claimed for THIS invite. The sweep must NOT re-send.
      reminderStampOffsetMs: 1 * 3_600_000,
    });

    // Tight-boundary seeds: 60s either side of each cutoff. The
    // "far from boundary" rows above prove the windows work in the
    // gross sense; these prove the comparators (`.lt`, `.gt`,
    // `.lte`) point the right way. Swapping a `.gt` for a `.lt`
    // (or removing the boundary check entirely) would flip the
    // inclusion of at least one of these.
    const ONE_MIN = 60_000;
    await seed("just-inside-reminder", {
      // Crossed the reminder cutoff (TTL-LEAD) by ~1m → reminder due.
      ageMs: TTL_MS - REMINDER_LEAD_MS + ONE_MIN,
    });
    await seed("just-before-reminder", {
      // Still 1m short of the reminder cutoff → no reminder, no expiry.
      ageMs: TTL_MS - REMINDER_LEAD_MS - ONE_MIN,
    });
    await seed("just-inside-expired", {
      // Crossed the expired cutoff (TTL) by ~1m → expired notice due,
      // and `expiredCutoff > set_by_admin_at` means the reminder query's
      // `.gt(set_by_admin_at, expiredCutoff)` MUST exclude this row.
      ageMs: TTL_MS + ONE_MIN,
    });

    const stats = await runInvitePasswordExpiryNotifySweep(FULL_CFG);

    // Headcount: the sweep should have considered at least the rows
    // we expect — 3 reminders (`reminder`, `stale`, `just-inside-reminder`)
    // and 2 expired (`expired`, `just-inside-expired`). Other
    // parallel-running suites could in principle also seed eligible
    // rows, so we assert >= rather than ===.
    expect(stats.remindersSent).toBeGreaterThanOrEqual(3);
    expect(stats.expiredSent).toBeGreaterThanOrEqual(2);
    expect(stats.errors).toBe(0);

    // The SendGrid mock should have been called once per email we
    // expect to have gone out. Filter to OUR run so unrelated
    // parallel suites don't pollute the assertion.
    const ourCalls = sendEmailMock.mock.calls.filter((call) => {
      const arg = call[0] as { to?: string } | undefined;
      return (
        typeof arg?.to === "string" && arg.to.startsWith(`${runTag}+`)
      );
    });
    const toAddresses = ourCalls.map(
      (c) => (c[0] as { to: string }).to,
    );
    expect(toAddresses).toEqual(
      expect.arrayContaining([
        emailFor("reminder"),
        emailFor("stale"),
        emailFor("expired"),
        emailFor("just-inside-reminder"),
        emailFor("just-inside-expired"),
      ]),
    );
    expect(toAddresses).not.toContain(emailFor("young"));
    expect(toAddresses).not.toContain(emailFor("claimed"));
    expect(toAddresses).not.toContain(emailFor("just-before-reminder"));

    // Read the post-sweep credential rows back via PostgREST (the
    // same client the sweep uses) to confirm the stamps landed
    // on the right columns AND on the right rows.
    const supabase = getSupabaseServiceRoleClient();
    const ids = Array.from(userIdBySlot.values());
    const { data, error } = await supabase
      .schema("resupply_auth")
      .from("password_credentials")
      .select(
        "user_id, set_by_admin_at, expiry_reminder_sent_at, expired_notice_sent_at",
      )
      .in("user_id", ids);
    expect(error).toBeNull();
    const byId = new Map(
      (data ?? []).map((r) => [r.user_id as string, r]),
    );

    // young — no stamps should be set.
    const young = byId.get(userIdBySlot.get("young")!)!;
    expect(young.expiry_reminder_sent_at).toBeNull();
    expect(young.expired_notice_sent_at).toBeNull();

    // reminder — reminder stamp set fresh; no expiry stamp.
    const reminder = byId.get(userIdBySlot.get("reminder")!)!;
    expect(reminder.expiry_reminder_sent_at).not.toBeNull();
    expect(
      new Date(reminder.expiry_reminder_sent_at as string).getTime(),
    ).toBeGreaterThan(new Date(reminder.set_by_admin_at as string).getTime());
    expect(reminder.expired_notice_sent_at).toBeNull();

    // expired — expiry-notice stamp set fresh.
    const expired = byId.get(userIdBySlot.get("expired")!)!;
    expect(expired.expired_notice_sent_at).not.toBeNull();
    expect(
      new Date(expired.expired_notice_sent_at as string).getTime(),
    ).toBeGreaterThan(new Date(expired.set_by_admin_at as string).getTime());

    // stale — reminder stamp was rewritten to a value AFTER
    // set_by_admin_at (the sweep treated the prior-invite stamp as
    // stale and re-claimed for this invite).
    const stale = byId.get(userIdBySlot.get("stale")!)!;
    expect(stale.expiry_reminder_sent_at).not.toBeNull();
    expect(
      new Date(stale.expiry_reminder_sent_at as string).getTime(),
    ).toBeGreaterThan(new Date(stale.set_by_admin_at as string).getTime());

    // just-inside-reminder — reminder stamp set, expiry NOT set
    // (proves the reminder query INCLUDES rows ~1m past TTL-LEAD
    // and the expired query EXCLUDES rows still inside TTL).
    const jir = byId.get(userIdBySlot.get("just-inside-reminder")!)!;
    expect(jir.expiry_reminder_sent_at).not.toBeNull();
    expect(jir.expired_notice_sent_at).toBeNull();

    // just-before-reminder — neither stamp set (proves the reminder
    // query EXCLUDES rows ~1m short of TTL-LEAD).
    const jbr = byId.get(userIdBySlot.get("just-before-reminder")!)!;
    expect(jbr.expiry_reminder_sent_at).toBeNull();
    expect(jbr.expired_notice_sent_at).toBeNull();

    // just-inside-expired — expiry stamp set, reminder NOT set
    // (proves `.gt(set_by_admin_at, expiredCutoff)` correctly
    // excludes rows ~1m past TTL from the reminder query).
    const jie = byId.get(userIdBySlot.get("just-inside-expired")!)!;
    expect(jie.expired_notice_sent_at).not.toBeNull();
    expect(jie.expiry_reminder_sent_at).toBeNull();

    // claimed — reminder stamp is the one we seeded (1h after
    // set_by_admin_at), proving the sweep did NOT re-stamp it.
    const claimed = byId.get(userIdBySlot.get("claimed")!)!;
    const claimedStampMs = new Date(
      claimed.expiry_reminder_sent_at as string,
    ).getTime();
    const claimedSetMs = new Date(
      claimed.set_by_admin_at as string,
    ).getTime();
    const diffMs = claimedStampMs - claimedSetMs;
    // The seed put the stamp at exactly +1h; allow ±5min for
    // clock skew between Date.now() in seed() and the DB write.
    expect(diffMs).toBeGreaterThan(55 * 60 * 1000);
    expect(diffMs).toBeLessThan(65 * 60 * 1000);
  });
});
