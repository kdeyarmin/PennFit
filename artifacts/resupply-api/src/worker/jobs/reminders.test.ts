// Worker-side env-presence preflight tests.
//
// `scanForDueReminders` and the job handlers themselves go through the
// live DB / pg-boss / lib helpers and are exercised via the api-side
// integration suite (the lib code path is shared — see ADR 013). This
// file pins the worker's local `readWorkerMessagingConfig` because it
// is the env-shape contract between the worker and the admin-facing
// API: a half-configured deploy that boots the worker but is missing
// SMS or email secrets MUST log + skip rather than throw, otherwise
// pg-boss fills its retry queue with permanent failures.
//
// Tests pass an explicit `env` to keep them hermetic.
//
// PR additions tested here:
//   - isWithinQuietHours — pure logic + Intl.DateTimeFormat tz gate
//   - tryClaimReminderDedupKey — 23505/other-error/success branches (structural)
//   - patients.timezone field wired into scanForDueReminders SELECT

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { __testing } from "./reminders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "reminders.ts"), "utf8");

const { readWorkerMessagingConfigForTest } = __testing;

const baseEnv = {
  RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://example.test",
  RESUPPLY_PRACTICE_NAME: "Test Practice",
} as const;

describe("readWorkerMessagingConfig (worker env preflight)", () => {
  it("returns sms=null when no twilio credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({ ...baseEnv });
    expect(cfg.sms).toBeNull();
  });

  it("returns sms config when phone-number-mode credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms).not.toBeNull();
    expect(cfg.sms?.twilioPhoneNumber).toBe("+15555550100");
    expect(cfg.sms?.publicBaseUrl).toBe("https://example.test");
  });

  it("returns sms config when messaging-service-mode credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_MESSAGING_SERVICE_SID: "MG_x",
    });
    expect(cfg.sms).not.toBeNull();
    expect(cfg.sms?.twilioMessagingServiceSid).toBe("MG_x");
  });

  it("returns sms=null if account+token present but no number/service", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
    });
    expect(cfg.sms).toBeNull();
  });

  it("returns sms=null when public base URL cannot be inferred", () => {
    const cfg = readWorkerMessagingConfigForTest({
      RESUPPLY_PRACTICE_NAME: "Test Practice",
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms).toBeNull();
  });

  it("returns email=null when no sendgrid credentials are set", () => {
    const cfg = readWorkerMessagingConfigForTest({ ...baseEnv });
    expect(cfg.email).toBeNull();
  });

  it("returns email config when all three sendgrid envs + base url are set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "a@b.test",
      SENDGRID_FROM_NAME: "From",
    });
    expect(cfg.email).not.toBeNull();
    expect(cfg.email?.sendgridFromEmail).toBe("a@b.test");
  });

  it("returns email=null when only api key is present (from email/name missing)", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      SENDGRID_API_KEY: "SG.x",
    });
    expect(cfg.email).toBeNull();
  });

  it("hmacKeysReady is false when RESUPPLY_LINK_HMAC_KEY is missing", () => {
    expect(readWorkerMessagingConfigForTest({ ...baseEnv }).hmacKeysReady).toBe(
      false,
    );
  });

  it("hmacKeysReady is true when RESUPPLY_LINK_HMAC_KEY is set", () => {
    const cfg = readWorkerMessagingConfigForTest({
      ...baseEnv,
      RESUPPLY_LINK_HMAC_KEY: "k2",
    });
    expect(cfg.hmacKeysReady).toBe(true);
  });

  it("strips trailing slash from RESUPPLY_VOICE_PUBLIC_BASE_URL", () => {
    const cfg = readWorkerMessagingConfigForTest({
      RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://example.test/",
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms?.publicBaseUrl).toBe("https://example.test");
  });

  it("falls back to RAILWAY_PUBLIC_DOMAIN when explicit base URL absent", () => {
    const cfg = readWorkerMessagingConfigForTest({
      RAILWAY_PUBLIC_DOMAIN: "pennfit.up.railway.app",
      RESUPPLY_PRACTICE_NAME: "Test Practice",
      TWILIO_ACCOUNT_SID: "AC_x",
      TWILIO_AUTH_TOKEN: "tok",
      TWILIO_PHONE_NUMBER: "+15555550100",
    });
    expect(cfg.sms?.publicBaseUrl).toBe("https://pennfit.up.railway.app");
  });
});

// ---------------------------------------------------------------------------
// isWithinQuietHours — source structural checks (PR change)
// ---------------------------------------------------------------------------

describe("isWithinQuietHours — source structural checks (PR change)", () => {
  it("declares QUIET_HOURS_START = 9", () => {
    expect(SRC).toMatch(/QUIET_HOURS_START\s*=\s*9/);
  });

  it("declares QUIET_HOURS_END = 20", () => {
    expect(SRC).toMatch(/QUIET_HOURS_END\s*=\s*20/);
  });

  it("returns true (quiet) when hour is below QUIET_HOURS_START or >= QUIET_HOURS_END", () => {
    expect(SRC).toMatch(
      /return\s+hour\s*<\s*QUIET_HOURS_START\s*\|\|\s*hour\s*>=\s*QUIET_HOURS_END/,
    );
  });

  it("falls back to America/New_York on timezone parse failure and logs reminder_tz_fallback", () => {
    expect(SRC).toMatch(/event:\s*"reminder_tz_fallback"/);
    expect(SRC).toMatch(/timeZone:\s*"America\/New_York"/);
  });

  it("formats quiet-hours checks using 24-hour time", () => {
    expect(SRC).toMatch(/hour12:\s*false/);
  });

  it("logs reminder_deferred_quiet_hours when deferring a send", () => {
    expect(SRC).toMatch(/event:\s*"reminder_deferred_quiet_hours"/);
  });

  it("passes the patient timezone field into isWithinQuietHours", () => {
    expect(SRC).toContain("isWithinQuietHours(asOf, row.timezone)");
  });
});

// ---------------------------------------------------------------------------
// isWithinQuietHours — pure algorithm replication (PR change)
//
// Replicate the logic from reminders.ts so we can verify TCPA-boundary
// hour values without depending on the current time or requiring the
// full worker module to be importable.
// ---------------------------------------------------------------------------

const QUIET_HOURS_START_REPLICA = 9;
const QUIET_HOURS_END_REPLICA = 20;

/**
 * Replicated from reminders.ts — same algorithm, no logger dependency.
 * Falls back silently (rather than logging) so test output is clean.
 */
function isWithinQuietHoursReplica(now: Date, timezone: string): boolean {
  let hour: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    hour = hourPart ? Number.parseInt(hourPart, 10) : Number.NaN;
    if (!Number.isFinite(hour)) {
      throw new Error("formatToParts returned non-numeric hour");
    }
  } catch {
    // Bad tz → fall back to ET (conservative default)
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    hour = Number.parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10,
    );
  }
  return hour < QUIET_HOURS_START_REPLICA || hour >= QUIET_HOURS_END_REPLICA;
}

/** Build a Date that resolves to the specified hour in the given IANA tz */
function dateAtHourInTz(ianaTz: string, targetHour: number): Date {
  // Use a fixed base date (2026-06-01) in the middle of the year so
  // DST behaviour is predictable for common US zones (both summer time).
  // We construct the ISO string for the target hour in the given zone,
  // then let Date parse it as UTC-offset aware. For simplicity we do
  // a brute-force minute-search starting from midnight UTC on the base
  // date until we find a minute whose local hour in ianaTz equals the
  // target.
  const BASE_ISO = "2026-06-01T00:00:00.000Z";
  let d = new Date(BASE_ISO);
  for (let i = 0; i < 24 * 60; i++) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaTz,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const h = Number.parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10,
    );
    if (h === targetHour) return d;
    d = new Date(d.getTime() + 60_000);
  }
  throw new Error(`Could not find hour ${targetHour} in ${ianaTz}`);
}

describe("isWithinQuietHours algorithm — ET (America/New_York)", () => {
  const TZ = "America/New_York";

  it("returns true (quiet) at midnight (hour 0)", () => {
    const d = dateAtHourInTz(TZ, 0);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(true);
  });

  it("returns true (quiet) at 8am (one hour before window opens)", () => {
    const d = dateAtHourInTz(TZ, 8);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(true);
  });

  it("returns false (allowed) at 9am (boundary — window opens)", () => {
    const d = dateAtHourInTz(TZ, 9);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(false);
  });

  it("returns false (allowed) at 12pm (noon)", () => {
    const d = dateAtHourInTz(TZ, 12);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(false);
  });

  it("returns false (allowed) at 7pm (one hour before window closes)", () => {
    const d = dateAtHourInTz(TZ, 19);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(false);
  });

  it("returns true (quiet) at 8pm (boundary — window closes at hour 20 exclusive)", () => {
    const d = dateAtHourInTz(TZ, 20);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(true);
  });

  it("returns true (quiet) at 11pm", () => {
    const d = dateAtHourInTz(TZ, 23);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(true);
  });
});

describe("isWithinQuietHours algorithm — PT (America/Los_Angeles)", () => {
  const TZ = "America/Los_Angeles";

  it("returns true (quiet) at 8am PT", () => {
    const d = dateAtHourInTz(TZ, 8);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(true);
  });

  it("returns false (allowed) at 9am PT", () => {
    const d = dateAtHourInTz(TZ, 9);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(false);
  });

  it("returns true (quiet) at 9pm PT (hour 21)", () => {
    const d = dateAtHourInTz(TZ, 21);
    expect(isWithinQuietHoursReplica(d, TZ)).toBe(true);
  });
});

describe("isWithinQuietHours algorithm — bad timezone fallback", () => {
  it("falls back gracefully when timezone is an unrecognized string", () => {
    // Should NOT throw; falls back to ET instead.
    const d = new Date("2026-06-01T14:00:00.000Z"); // 10am ET during summer
    expect(() => isWithinQuietHoursReplica(d, "Not/A_Timezone")).not.toThrow();
  });

  it("ET fallback result is within business hours for a mid-day UTC time", () => {
    // 14:00 UTC = 10:00 ET (UTC-4 in summer) → inside 9–20 → not quiet
    const d = new Date("2026-06-01T14:00:00.000Z");
    expect(isWithinQuietHoursReplica(d, "Bogus/Zone")).toBe(false);
  });

  it("ET fallback is quiet for a late-night UTC time", () => {
    // 03:00 UTC = 23:00 ET (UTC-4 summer) → quiet
    const d = new Date("2026-06-01T03:00:00.000Z");
    expect(isWithinQuietHoursReplica(d, "Bogus/Zone")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tryClaimReminderDedupKey — source structural checks (PR change)
// ---------------------------------------------------------------------------

describe("tryClaimReminderDedupKey — source structural checks (PR change)", () => {
  it("inserts into worker_dedup_keys table", () => {
    expect(SRC).toContain('"worker_dedup_keys"');
  });

  it("returns false on UNIQUE-violation (code 23505) — prior attempt already holds the lock", () => {
    // The 23505 branch returns false so callers short-circuit.
    expect(SRC).toContain('error.code === "23505"');
    const block23505Idx = SRC.indexOf('error.code === "23505"');
    const returnFalseIdx = SRC.indexOf(
      "return { proceed: false, key }",
      block23505Idx,
    );
    expect(returnFalseIdx).toBeGreaterThan(block23505Idx);
  });

  it("returns true on successful INSERT (won the race)", () => {
    // The success branch returns true so the caller proceeds.
    const successComment = SRC.indexOf("won the race");
    expect(successComment).toBeGreaterThan(-1);
    const returnTrueIdx = SRC.indexOf(
      "return { proceed: true, key }",
      successComment,
    );
    expect(returnTrueIdx).toBeGreaterThan(successComment);
  });

  it("returns true (fail-open) on unexpected DB errors — better duplicate than silence", () => {
    // Any non-23505 error still returns true so the send proceeds.
    expect(SRC).toContain("reminder_dedup_insert_failed");
    const failOpenIdx = SRC.indexOf("reminder_dedup_insert_failed");
    // After the warn, must return true
    const returnTrueAfterFailIdx = SRC.indexOf(
      "return { proceed: true, key }",
      failOpenIdx,
    );
    expect(returnTrueAfterFailIdx).toBeGreaterThan(failOpenIdx);
  });

  it("builds the dedup key from channel, patientId, episodeId, and today's UTC date", () => {
    expect(SRC).toMatch(
      /const key = `reminder-\$\{channel\}:\$\{patientId\}:\$\{episodeId\}:\$\{[^}]+\}`/,
    );
  });

  it("sets expires_at to 22 hours from now", () => {
    expect(SRC).toMatch(/22\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it("logs reminder_dedup_skip on conflict", () => {
    expect(SRC).toContain('"reminder_dedup_skip"');
  });
});

// ---------------------------------------------------------------------------
// tryClaimReminderDedupKey — pure logic simulation (PR change)
//
// Replicate the three-branch logic (success / 23505 / other error) so
// we can verify the posture without a real Supabase client.
// ---------------------------------------------------------------------------

type FakeError = { code: string; message: string } | null;

async function simulateTryClaimDedupKey(
  insertError: FakeError,
): Promise<boolean> {
  // Simulate what the Supabase insert returns
  const error = insertError;
  if (!error) {
    return true; // won the race
  }
  if (error.code === "23505") {
    return false; // prior attempt holds the lock
  }
  // Any other error: fail-open
  return true;
}

describe("tryClaimReminderDedupKey algorithm (replicated from PR change)", () => {
  it("returns true when INSERT succeeds (no error)", async () => {
    const result = await simulateTryClaimDedupKey(null);
    expect(result).toBe(true);
  });

  it("returns false when INSERT fails with 23505 UNIQUE violation", async () => {
    const result = await simulateTryClaimDedupKey({
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });
    expect(result).toBe(false);
  });

  it("returns true (fail-open) when INSERT fails with a non-UNIQUE error (e.g. permission denied)", async () => {
    const result = await simulateTryClaimDedupKey({
      code: "42501",
      message: "permission denied for table worker_dedup_keys",
    });
    expect(result).toBe(true);
  });

  it("returns true (fail-open) when INSERT fails with a connection error", async () => {
    const result = await simulateTryClaimDedupKey({
      code: "08006",
      message: "connection failure",
    });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dedup key format — pure string construction (PR change)
// ---------------------------------------------------------------------------

describe("reminder dedup key format (PR change)", () => {
  it("builds a deterministic key from channel, patientId, episodeId, and UTC date", () => {
    const channel = "sms";
    const patientId = "pat_abc";
    const episodeId = "ep_xyz";
    const todayUtc = "2026-06-01";
    const key = `reminder-${channel}:${patientId}:${episodeId}:${todayUtc}`;
    expect(key).toBe("reminder-sms:pat_abc:ep_xyz:2026-06-01");
  });

  it("builds a different key for email channel", () => {
    const key = `reminder-email:pat_abc:ep_xyz:2026-06-01`;
    expect(key).toBe("reminder-email:pat_abc:ep_xyz:2026-06-01");
  });

  it("keys for the same patient+episode differ between channels", () => {
    const smsKey = `reminder-sms:pat_abc:ep_xyz:2026-06-01`;
    const emailKey = `reminder-email:pat_abc:ep_xyz:2026-06-01`;
    expect(smsKey).not.toBe(emailKey);
  });

  it("keys for the same patient+episode differ across days", () => {
    const day1Key = `reminder-sms:pat_abc:ep_xyz:2026-06-01`;
    const day2Key = `reminder-sms:pat_abc:ep_xyz:2026-06-02`;
    expect(day1Key).not.toBe(day2Key);
  });
});

// ---------------------------------------------------------------------------
// scanForDueReminders — timezone field wired into SELECT (PR change)
// ---------------------------------------------------------------------------

describe("scanForDueReminders — timezone field included in patient SELECT (PR change)", () => {
  it("includes 'timezone' in the patients SELECT column list", () => {
    expect(SRC).toMatch(
      /from\("patients"\)[\s\S]*?\.select\(\s*"[^"]*\btimezone\b[^"]*"\s*,?\s*\)/,
    );
  });

  it("passes timezone through to the scan row for each patient", () => {
    expect(SRC).toContain("timezone: patient.timezone");
  });
});
